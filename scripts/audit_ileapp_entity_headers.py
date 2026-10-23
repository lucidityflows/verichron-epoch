#!/usr/bin/env python3
"""Compare source-declared iLEAPP headers with the reviewed pinned baseline."""

from __future__ import annotations

import argparse
import ast
import copy
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = REPOSITORY_ROOT / "tools" / "ileapp" / "iLEAPP"
ARTIFACTS_ROOT = SOURCE_ROOT / "scripts" / "artifacts"
BASELINE_DIR = REPOSITORY_ROOT / "packages" / "contracts" / "ileapp_source_headers"
INDEX_PATH = BASELINE_DIR / "index.json"
SHARD_MODULE_LIMIT = 12
SHARD_MAX_BYTES = 250_000


def _resolve(expression: ast.expr, names: dict[str, Any]) -> Any:
    try:
        return ast.literal_eval(expression)
    except ValueError, TypeError, SyntaxError:
        pass

    if isinstance(expression, ast.Name) and expression.id in names:
        return names[expression.id]
    if isinstance(expression, ast.List):
        return [_resolve(element, names) for element in expression.elts]
    if isinstance(expression, ast.Tuple):
        return tuple(_resolve(element, names) for element in expression.elts)
    if isinstance(expression, ast.Set):
        return {_resolve(element, names) for element in expression.elts}
    if isinstance(expression, ast.Dict):
        result: dict[Any, Any] = {}
        for key, value in zip(expression.keys, expression.values, strict=True):
            if key is None:
                raise ValueError("dictionary unpacking is not supported")
            result[_resolve(key, names)] = _resolve(value, names)
        return result
    if isinstance(expression, ast.Compare) and len(expression.ops) == len(expression.comparators) == 1:
        left = _resolve(expression.left, names)
        right = _resolve(expression.comparators[0], names)
        if isinstance(expression.ops[0], ast.Eq):
            return left == right
        if isinstance(expression.ops[0], ast.NotEq):
            return left != right
    if isinstance(expression, ast.ListComp) and len(expression.generators) == 1:
        generator = expression.generators[0]
        if generator.is_async or not isinstance(generator.target, ast.Name):
            raise ValueError("comprehension is not a supported static expression")
        values = _resolve(generator.iter, names)
        comprehension_result = []
        for value in values:
            local_names = dict(names)
            local_names[generator.target.id] = value
            if all(_resolve(condition, local_names) for condition in generator.ifs):
                comprehension_result.append(_resolve(expression.elt, local_names))
        return comprehension_result
    if isinstance(expression, ast.BinOp) and isinstance(expression.op, ast.Add):
        left = _resolve(expression.left, names)
        right = _resolve(expression.right, names)
        return left + right
    if isinstance(expression, ast.Subscript):
        return _resolve(expression.value, names)[_resolve(expression.slice, names)]
    if isinstance(expression, ast.Slice):
        return slice(
            _resolve(expression.lower, names) if expression.lower is not None else None,
            _resolve(expression.upper, names) if expression.upper is not None else None,
            _resolve(expression.step, names) if expression.step is not None else None,
        )
    if isinstance(expression, ast.Call) and isinstance(expression.func, ast.Name):
        constructors = {"list": list, "tuple": tuple, "set": set}
        if expression.func.id in constructors and len(expression.args) <= 1 and not expression.keywords:
            values = [_resolve(argument, names) for argument in expression.args]
            return constructors[expression.func.id](*values)
    if (
        isinstance(expression, ast.Call)
        and isinstance(expression.func, ast.Attribute)
        and expression.func.attr == "index"
        and len(expression.args) == 1
        and not expression.keywords
    ):
        values = _resolve(expression.func.value, names)
        if isinstance(values, (list, tuple)):
            return values.index(_resolve(expression.args[0], names))
    raise ValueError("header declaration is not a supported static expression")


def _assignments(nodes: list[ast.stmt]) -> list[ast.Assign | ast.AnnAssign | ast.AugAssign | ast.Expr]:
    found: list[ast.Assign | ast.AnnAssign | ast.AugAssign | ast.Expr] = []

    class Visitor(ast.NodeVisitor):
        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            return

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            return

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            return

        def visit_Assign(self, node: ast.Assign) -> None:
            found.append(node)
            self.generic_visit(node)

        def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
            found.append(node)
            self.generic_visit(node)

        def visit_AugAssign(self, node: ast.AugAssign) -> None:
            found.append(node)
            self.generic_visit(node)

        def visit_Expr(self, node: ast.Expr) -> None:
            found.append(node)
            self.generic_visit(node)

    visitor = Visitor()
    for node in nodes:
        visitor.visit(node)
    return sorted(found, key=lambda node: node.lineno)


def _target_names(target: ast.expr) -> set[str]:
    if isinstance(target, ast.Name):
        return {target.id}
    if isinstance(target, (ast.Tuple, ast.List)):
        return set().union(*(_target_names(element) for element in target.elts))
    return set()


def _bound_values(target: ast.expr, value: Any) -> dict[str, Any]:
    if isinstance(target, ast.Name):
        return {target.id: value}
    if isinstance(target, (ast.Tuple, ast.List)) and isinstance(value, (list, tuple)):
        if len(target.elts) != len(value):
            return {}
        return {
            name: nested_value
            for element, bound_value in zip(target.elts, value, strict=True)
            for name, nested_value in _bound_values(element, bound_value).items()
        }
    return {}


def _container_ids(value: Any) -> set[int]:
    if isinstance(value, dict):
        identities = {id(value)}
        for key, item in value.items():
            identities.update(_container_ids(key))
            identities.update(_container_ids(item))
        return identities
    if isinstance(value, (list, tuple, set)):
        return {id(value), *(identity for item in value for identity in _container_ids(item))}
    return set()


def _invalidate_bindings(names: dict[str, Any], targets: set[str]) -> None:
    invalid_ids = set().union(*(_container_ids(names[name]) for name in targets if name in names))
    for name, value in list(names.items()):
        if name in targets or _container_ids(value) & invalid_ids:
            names.pop(name)


def _is_artifact_processor(function: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    for decorator in function.decorator_list:
        target = decorator.func if isinstance(decorator, ast.Call) else decorator
        if isinstance(target, ast.Name) and target.id == "artifact_processor":
            return True
    return False


def _module_constants(tree: ast.Module) -> dict[str, Any]:
    names: dict[str, Any] = {}
    for node in tree.body:
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        value = node.value
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        if value is None:
            continue
        try:
            resolved = _resolve(value, names)
        except IndexError, KeyError, TypeError, ValueError:
            continue
        for target in targets:
            names.update(_bound_values(target, resolved))
    return names


def _header_declaration(
    function: ast.FunctionDef | ast.AsyncFunctionDef,
    constants: dict[str, Any],
    functions: dict[str, ast.FunctionDef | ast.AsyncFunctionDef],
    seen: set[str],
    bindings: dict[str, Any] | None = None,
) -> tuple[list[Any] | None, str | None]:
    if function.name in seen:
        return None, "artifact header helper call is recursive"
    seen.add(function.name)
    names = copy.deepcopy(constants)
    if bindings is not None:
        names.update(copy.deepcopy(bindings))
    declarations: list[list[Any]] = []
    for node in _assignments(function.body):
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            call = node.value
            if isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name):
                target_name = call.func.value.id
                target = names.get(target_name)
                if isinstance(target, list) and call.func.attr in {"append", "extend", "insert"}:
                    updates_headers = target is names.get("data_headers")
                    try:
                        arguments = [_resolve(argument, names) for argument in call.args]
                    except IndexError, KeyError, TypeError, ValueError:
                        _invalidate_bindings(names, {target_name})
                        if updates_headers:
                            return None, "data_headers is mutated dynamically"
                        continue
                    if call.func.attr == "append" and len(arguments) == 1:
                        target.append(arguments[0])
                    elif call.func.attr == "extend" and len(arguments) == 1 and isinstance(arguments[0], (list, tuple)):
                        target.extend(arguments[0])
                    elif call.func.attr == "insert" and len(arguments) == 2 and isinstance(arguments[0], int):
                        target.insert(arguments[0], arguments[1])
                    else:
                        _invalidate_bindings(names, {target_name})
                        if target_name == "data_headers":
                            return None, "data_headers is mutated dynamically"
                        continue
                    if updates_headers:
                        for declaration in declarations:
                            if call.func.attr == "append" and len(arguments) == 1:
                                declaration.append(arguments[0])
                            elif (
                                call.func.attr == "extend"
                                and len(arguments) == 1
                                and isinstance(arguments[0], (list, tuple))
                            ):
                                declaration.extend(arguments[0])
                            elif call.func.attr == "insert" and len(arguments) == 2 and isinstance(arguments[0], int):
                                declaration.insert(arguments[0], arguments[1])
                elif target_name == "data_headers":
                    return None, "data_headers is mutated dynamically"
            continue

        if isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name):
            if node.target.id == "data_headers":
                return None, "data_headers is updated dynamically"
            if node.target.id in names:
                try:
                    value = _resolve(node.value, names)
                    if isinstance(node.op, ast.Add):
                        names[node.target.id] = names[node.target.id] + value
                except IndexError, KeyError, TypeError, ValueError:
                    updates_headers = names[node.target.id] is names.get("data_headers")
                    _invalidate_bindings(names, {node.target.id})
                    if updates_headers:
                        return None, "data_headers is updated dynamically"
                    continue
            continue

        if isinstance(node, ast.Assign):
            subscript_targets = [
                target
                for target in node.targets
                if isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name)
            ]
            if subscript_targets:
                try:
                    value = _resolve(node.value, names)
                    for target in subscript_targets:
                        if not isinstance(target.value, ast.Name):
                            continue
                        target_name = target.value.id
                        current = names.get(target_name)
                        if not isinstance(current, (list, tuple)):
                            if target_name == "data_headers":
                                return None, "data_headers is mutated dynamically"
                            continue
                        updates_headers = current is names.get("data_headers")
                        updated = list(current)
                        index = _resolve(target.slice, names)
                        updated[index] = value
                        names[target_name] = updated
                        if updates_headers:
                            names["data_headers"] = updated
                            for declaration in declarations:
                                declaration[index] = value
                except IndexError, KeyError, TypeError, ValueError:
                    target_names = {
                        target.value.id for target in subscript_targets if isinstance(target.value, ast.Name)
                    }
                    updates_headers = any(names.get(name) is names.get("data_headers") for name in target_names)
                    _invalidate_bindings(names, target_names)
                    if updates_headers or "data_headers" in target_names:
                        return None, "data_headers is mutated dynamically"
                continue
            value = node.value
            targets = node.targets
        elif isinstance(node, ast.AnnAssign):
            value = node.value
            targets = [node.target]
        else:
            continue

        if value is None:
            continue
        if (
            any("data_headers" in _target_names(target) for target in targets)
            and isinstance(value, ast.Call)
            and isinstance(value.func, ast.Name)
            and value.func.id == "remove_unused_rows"
            and "data_headers" in names
        ):
            declarations.append(list(names["data_headers"]))
            continue
        target_values: dict[str, Any] = {}
        try:
            resolved_value = _resolve(value, names)
        except IndexError, KeyError, TypeError, ValueError:
            target_names = set().union(*(_target_names(target) for target in targets))
            _invalidate_bindings(names, target_names)
            if any("data_headers" in _target_names(target) for target in targets):
                return None, "data_headers is not a supported static expression"
            continue
        for target in targets:
            target_values.update(_bound_values(target, resolved_value))
        if any("data_headers" in _target_names(target) for target in targets) and "data_headers" not in target_values:
            _invalidate_bindings(names, {"data_headers"})
            return None, "data_headers is not a supported static expression"
        for name, resolved in target_values.items():
            if name == "data_headers":
                if not isinstance(resolved, (list, tuple)):
                    return None, "data_headers is not a list or tuple"
                names[name] = resolved
                declarations.append(list(resolved))
            else:
                names[name] = resolved

    if not declarations:
        for node in _returns(function.body):
            if isinstance(node.value, (ast.List, ast.Tuple)) and node.value.elts:
                try:
                    returned_headers = _resolve(node.value.elts[0], names)
                except IndexError, KeyError, TypeError, ValueError:
                    continue
                if isinstance(returned_headers, (list, tuple)):
                    declarations.append(list(returned_headers))
                    continue
            if isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name):
                helper = functions.get(node.value.func.id)
                if helper is not None:
                    helper_bindings: dict[str, Any] = {}
                    positional_parameters = [*helper.args.posonlyargs, *helper.args.args]
                    for parameter, argument in zip(positional_parameters, node.value.args, strict=False):
                        try:
                            helper_bindings[parameter.arg] = _resolve(argument, names)
                        except IndexError, KeyError, TypeError, ValueError:
                            continue
                    for keyword in node.value.keywords:
                        if keyword.arg is None:
                            continue
                        try:
                            helper_bindings[keyword.arg] = _resolve(keyword.value, names)
                        except IndexError, KeyError, TypeError, ValueError:
                            continue
                    helper_headers, error = _header_declaration(
                        helper, constants, functions, set(seen), helper_bindings
                    )
                    if error is not None:
                        return None, error
                    if helper_headers is not None:
                        declarations.append(list(helper_headers))
        if not declarations:
            return None, "artifact processor does not declare data_headers"
    headers: list[Any] = []
    seen_headers: set[str] = set()
    for declaration in declarations:
        for header in declaration:
            identity = json.dumps(_json_value(header), sort_keys=True, ensure_ascii=False)
            if identity not in seen_headers:
                headers.append(header)
                seen_headers.add(identity)
    for header in headers:
        if isinstance(header, str):
            continue
        if isinstance(header, (list, tuple)) and header and all(isinstance(part, str) for part in header):
            continue
        return None, "data_headers contains an unsupported declaration"
    return [_json_value(header) for header in headers], None


def _returns(nodes: list[ast.stmt]) -> list[ast.Return]:
    found: list[ast.Return] = []

    class Visitor(ast.NodeVisitor):
        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            return

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            return

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            return

        def visit_Return(self, node: ast.Return) -> None:
            found.append(node)

    visitor = Visitor()
    for node in nodes:
        visitor.visit(node)
    return found


def _json_value(value: Any) -> Any:
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    return value


def _no_output_artifacts(tree: ast.Module, constants: dict[str, Any]) -> set[str]:
    declaration = next(
        (
            node.value
            for node in tree.body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "__artifacts_v2__" for target in node.targets)
        ),
        None,
    )
    if declaration is None:
        return set()
    try:
        artifacts = _resolve(declaration, constants)
    except TypeError, ValueError:
        return set()
    if not isinstance(artifacts, dict):
        return set()
    return {
        name
        for name, metadata in artifacts.items()
        if isinstance(metadata, dict) and metadata.get("output_types") == "none"
    }


def scan_source(
    artifacts_root: Path,
) -> tuple[list[str], dict[str, dict[str, list[Any]]], dict[str, list[str]], list[str]]:
    """Collect statically declared data_headers without importing or executing iLEAPP."""
    modules: list[str] = []
    artifacts: dict[str, dict[str, list[Any]]] = {}
    no_output_artifacts: dict[str, list[str]] = {}
    errors: list[str] = []

    for path in sorted(artifacts_root.rglob("*.py")):
        relative_path = path.relative_to(artifacts_root.parent.parent).as_posix()
        modules.append(relative_path)
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=relative_path)
        except (OSError, UnicodeError, SyntaxError) as error:
            errors.append(f"{relative_path}::source: could not parse source ({type(error).__name__})")
            continue

        constants = _module_constants(tree)
        no_output = _no_output_artifacts(tree, constants)
        if no_output:
            no_output_artifacts[relative_path] = sorted(no_output)
        functions = {node.name: node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
        module_artifacts: dict[str, list[Any]] = {}
        for node in tree.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or not _is_artifact_processor(node):
                continue
            headers, error = _header_declaration(node, constants, functions, set())
            if error is not None:
                if node.name not in no_output:
                    errors.append(f"{relative_path}::{node.name}: {error}")
                continue
            if headers is None:
                errors.append(f"{relative_path}::{node.name}: no static header declaration was resolved")
                continue
            module_artifacts[node.name] = headers

        if module_artifacts:
            artifacts[relative_path] = module_artifacts

    return modules, artifacts, no_output_artifacts, errors


def _pinned_commit() -> str:
    result = subprocess.run(
        ["git", "-C", str(REPOSITORY_ROOT), "rev-parse", "HEAD:tools/ileapp/iLEAPP"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _source_commit() -> str:
    result = subprocess.run(
        ["git", "-C", str(SOURCE_ROOT), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _source_tree_changes() -> list[str]:
    status = subprocess.run(
        [
            "git",
            "-C",
            str(SOURCE_ROOT),
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--",
            ":(glob)scripts/artifacts/**/*.py",
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    ignored = subprocess.run(
        [
            "git",
            "-C",
            str(SOURCE_ROOT),
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--",
            ":(glob)scripts/artifacts/**/*.py",
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    return [*status, *(f"ignored: {path}" for path in ignored)]


def _baseline(
    commit: str,
    modules: list[str],
    artifacts: dict[str, dict[str, list[Any]]],
    no_output_artifacts: dict[str, list[str]],
    unresolved: list[str],
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "ileapp_commit": commit,
        "modules": modules,
        "artifacts": artifacts,
        "no_output_artifacts": no_output_artifacts,
        "unresolved": unresolved,
    }


def _shards(
    modules: list[str],
    artifacts: dict[str, dict[str, list[Any]]],
    no_output_artifacts: dict[str, list[str]],
    unresolved: list[str],
) -> dict[str, dict[str, Any]]:
    shards: dict[str, dict[str, Any]] = {}
    modules_by_initial: dict[str, list[str]] = {}
    module_entries: dict[str, dict[str, Any]] = {}
    for module in sorted(modules):
        first = Path(module).name[0].lower()
        initial = first if first.isalpha() else "other"
        modules_by_initial.setdefault(initial, []).append(module)
        module_entries[module] = {
            "artifacts": artifacts.get(module, {}),
            "no_output_artifacts": no_output_artifacts.get(module, []),
            "unresolved": [],
        }

    for item in unresolved:
        module, _ = item.split("::", 1)
        module_entries[module]["unresolved"].append(item)

    for initial, initial_modules in sorted(modules_by_initial.items()):
        chunks: list[dict[str, dict[str, Any]]] = []
        current_chunk: dict[str, dict[str, Any]] = {}
        for module in initial_modules:
            candidate = {**current_chunk, module: module_entries[module]}
            candidate_size = len(json.dumps({"modules": candidate}, indent=2, ensure_ascii=False).encode("utf-8"))
            if candidate_size > SHARD_MAX_BYTES and not current_chunk:
                raise ValueError(
                    f"Source inventory for {module} exceeds the {SHARD_MAX_BYTES}-byte shard limit "
                    f"({candidate_size} bytes)."
                )
            if current_chunk and (len(current_chunk) >= SHARD_MODULE_LIMIT or candidate_size > SHARD_MAX_BYTES):
                chunks.append(current_chunk)
                current_chunk = {}
            current_chunk[module] = module_entries[module]
        if current_chunk:
            chunks.append(current_chunk)

        for chunk_number, chunk in enumerate(chunks, start=1):
            shard_name = f"{initial}.json" if len(chunks) == 1 else f"{initial}-{chunk_number:02}.json"
            shard = shards.setdefault(shard_name, {"modules": {}})
            shard["modules"] = chunk
    return shards


def _header_name(header: Any) -> str:
    return header[0] if isinstance(header, (list, tuple)) else header


def compare_baselines(previous: dict[str, Any], current: dict[str, Any]) -> list[str]:
    changes: list[str] = []
    if previous["ileapp_commit"] != current["ileapp_commit"]:
        changes.append(f"reviewed pin changed: {previous['ileapp_commit']} -> {current['ileapp_commit']}")
    old_modules = set(previous["modules"])
    new_modules = set(current["modules"])
    for module in sorted(new_modules - old_modules):
        changes.append(f"new module: {module}")
    for module in sorted(old_modules - new_modules):
        changes.append(f"removed module: {module}")

    old_artifacts = previous["artifacts"]
    new_artifacts = current["artifacts"]
    old_no_output = previous.get("no_output_artifacts", {})
    new_no_output = current.get("no_output_artifacts", {})
    for module in sorted(set(old_no_output) | set(new_no_output)):
        old_names = set(old_no_output.get(module, []))
        new_names = set(new_no_output.get(module, []))
        for name in sorted(new_names - old_names):
            changes.append(f"new non-tabular artifact: {module}::{name}")
        for name in sorted(old_names - new_names):
            changes.append(f"removed non-tabular artifact: {module}::{name}")
    for module in sorted(set(old_artifacts) | set(new_artifacts)):
        old_module = old_artifacts.get(module, {})
        new_module = new_artifacts.get(module, {})
        for artifact in sorted(set(old_module) | set(new_module)):
            key = f"{module}::{artifact}"
            if artifact not in old_module:
                changes.append(f"new artifact: {key} ({len(new_module[artifact])} headers)")
                continue
            if artifact not in new_module:
                changes.append(f"removed artifact: {key}")
                continue

            old_headers = old_module[artifact]
            new_headers = new_module[artifact]
            artifact_changes: list[str] = []
            old_names = Counter(_header_name(header) for header in old_headers)
            new_names = Counter(_header_name(header) for header in new_headers)
            for name in sorted(new_names.keys() - old_names.keys()):
                artifact_changes.append(f"added header: {key} :: {name}")
            for name in sorted(old_names.keys() - new_names.keys()):
                artifact_changes.append(f"removed header: {key} :: {name} (possible rename)")
            for name in sorted(old_names.keys() & new_names.keys()):
                old_declarations = [h for h in old_headers if _header_name(h) == name]
                new_declarations = [h for h in new_headers if _header_name(h) == name]
                if old_declarations != new_declarations:
                    artifact_changes.append(f"changed declaration: {key} :: {name}")
            if not artifact_changes and old_headers != new_headers:
                artifact_changes.append(f"header order changed: {key}")
            changes.extend(artifact_changes)

    old_unresolved = set(previous.get("unresolved", []))
    new_unresolved = set(current.get("unresolved", []))
    for item in sorted(new_unresolved - old_unresolved):
        changes.append(f"unresolved declaration added: {item}")
    for item in sorted(old_unresolved - new_unresolved):
        changes.append(f"unresolved declaration removed: {item}")
    return changes


def _load_baseline(index_path: Path) -> dict[str, Any]:
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except OSError, UnicodeError, json.JSONDecodeError:
        raise ValueError("Could not read the reviewed iLEAPP source-header baseline.") from None
    if (
        not isinstance(index, dict)
        or index.get("schema_version") != 1
        or not isinstance(index.get("ileapp_commit"), str)
        or not isinstance(index.get("shards"), dict)
    ):
        raise ValueError("The reviewed iLEAPP source-header index has an invalid structure.")

    modules: list[str] = []
    artifacts: dict[str, dict[str, list[Any]]] = {}
    no_output_artifacts: dict[str, list[str]] = {}
    unresolved: list[str] = []
    for shard_name, relative_path in sorted(index["shards"].items()):
        if (
            not isinstance(shard_name, str)
            or not isinstance(relative_path, str)
            or Path(relative_path).name != relative_path
            or relative_path != shard_name
        ):
            raise ValueError("The reviewed iLEAPP source-header index contains an invalid shard path.")
        try:
            shard = json.loads((index_path.parent / relative_path).read_text(encoding="utf-8"))
        except OSError, UnicodeError, json.JSONDecodeError:
            raise ValueError("Could not read an iLEAPP source-header shard.") from None
        if not isinstance(shard, dict) or not isinstance(shard.get("modules"), dict):
            raise ValueError(f"The iLEAPP source-header shard {shard_name} has an invalid structure.")
        for module, entry in shard["modules"].items():
            if not isinstance(module, str) or not isinstance(entry, dict):
                raise ValueError(f"The iLEAPP source-header shard {shard_name} has an invalid module entry.")
            module_artifacts = entry.get("artifacts")
            module_no_output = entry.get("no_output_artifacts")
            module_unresolved = entry.get("unresolved")
            if (
                not isinstance(module_artifacts, dict)
                or not isinstance(module_no_output, list)
                or not isinstance(module_unresolved, list)
            ):
                raise ValueError(f"The iLEAPP source-header shard {shard_name} has an invalid module entry.")
            modules.append(module)
            if module_artifacts:
                artifacts[module] = module_artifacts
            if module_no_output:
                no_output_artifacts[module] = module_no_output
            unresolved.extend(module_unresolved)
    return {
        "schema_version": index["schema_version"],
        "ileapp_commit": index["ileapp_commit"],
        "modules": sorted(modules),
        "artifacts": artifacts,
        "no_output_artifacts": no_output_artifacts,
        "unresolved": sorted(unresolved),
    }


def _write_baseline(current: dict[str, Any], directory: Path = BASELINE_DIR) -> Path:
    shards = _shards(
        current["modules"],
        current["artifacts"],
        current["no_output_artifacts"],
        current["unresolved"],
    )
    directory.mkdir(parents=True, exist_ok=True)
    index_path = directory / "index.json"
    for shard_name, contents in sorted(shards.items()):
        (directory / shard_name).write_text(
            json.dumps(contents, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    for stale_path in directory.glob("*.json"):
        if (
            stale_path.name not in shards
            and stale_path.name != "index.json"
            and re.fullmatch(r"(?:[a-z]|other)(?:-\d{2})?\.json", stale_path.name)
            and stale_path.is_file()
            and not stale_path.is_symlink()
        ):
            stale_path.unlink()
    index = {
        "schema_version": current["schema_version"],
        "ileapp_commit": current["ileapp_commit"],
        "shards": {name: name for name in sorted(shards)},
    }
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return index_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="replace the reviewed source baseline with declarations from the pinned iLEAPP commit",
    )
    args = parser.parse_args()

    try:
        pinned_commit = _pinned_commit()
        if _source_commit() != pinned_commit:
            raise ValueError("The checked-out iLEAPP source does not match the superproject's pinned commit.")
        source_changes = _source_tree_changes()
        if source_changes:
            details = "\n".join(source_changes)
            raise ValueError(f"The iLEAPP artifact source tree has local changes; refusing to audit it:\n{details}")
        modules, artifacts, no_output_artifacts, unresolved = scan_source(ARTIFACTS_ROOT)
        current = _baseline(pinned_commit, modules, artifacts, no_output_artifacts, unresolved)
        if args.update_baseline:
            index_path = _write_baseline(current)
            print(
                f"Updated {index_path.relative_to(REPOSITORY_ROOT)} "
                f"and {len(_shards(modules, artifacts, no_output_artifacts, unresolved))} shards"
            )
            if unresolved:
                print(f"{len(unresolved)} unresolved header declarations require review:")
                print("\n".join(unresolved))
                return 1
            return 0

        previous = _load_baseline(INDEX_PATH)
        changes = compare_baselines(previous, current)
        artifact_count = sum(len(entries) for entries in artifacts.values()) + sum(
            len(entries) for entries in no_output_artifacts.values()
        )
        print(
            f"iLEAPP source: {len(modules)} modules, "
            f"{artifact_count} artifact declarations, "
            f"{sum(len(headers) for entries in artifacts.values() for headers in entries.values())} headers"
        )
        print(f"Reviewed pin: {previous['ileapp_commit']}; current pin: {pinned_commit}")
        if unresolved:
            print(f"{len(unresolved)} unresolved header declarations require review:")
            print("\n".join(unresolved))
        if not changes:
            if unresolved:
                return 1
            print("No source-header changes.")
            return 0
        print("\n".join(changes))
        return 1
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
