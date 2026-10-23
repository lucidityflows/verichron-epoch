#!/usr/bin/env python3
"""Compare source-declared iLEAPP headers with the reviewed pinned baseline."""

from __future__ import annotations

import argparse
import ast
import copy
import hashlib
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
HEADER_CONSUMER_CALLS = {
    "write_artifact_data_table",
    "lava_process_artifact",
    "lava_insert_sqlite_data",
}


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
        if expression.func.id in {"len", "sorted"} and len(expression.args) == 1 and not expression.keywords:
            value = _resolve(expression.args[0], names)
            return len(value) if expression.func.id == "len" else sorted(value)
    if (
        isinstance(expression, ast.Call)
        and isinstance(expression.func, ast.Attribute)
        and expression.func.attr == "copy"
        and not expression.args
        and not expression.keywords
    ):
        value = _resolve(expression.func.value, names)
        if isinstance(value, list):
            return value.copy()
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
    if isinstance(expression, ast.Call):
        inputs = [*expression.args, *(keyword.value for keyword in expression.keywords)]
        if isinstance(expression.func, ast.Attribute):
            inputs.append(expression.func.value)
        exposed_ids: set[int] = set()
        for argument in inputs:
            try:
                exposed_ids.update(_container_ids(_resolve(argument, names), mutable_only=True))
            except IndexError, KeyError, TypeError, ValueError:
                for node in ast.walk(argument):
                    if isinstance(node, ast.Name) and node.id in names:
                        exposed_ids.update(_container_ids(names[node.id], mutable_only=True))
        for name, value in list(names.items()):
            if _container_ids(value) & exposed_ids:
                names.pop(name)
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


def _container_ids(value: Any, *, mutable_only: bool = False) -> set[int]:
    if isinstance(value, dict):
        identities = {id(value)}
        for key, item in value.items():
            identities.update(_container_ids(key, mutable_only=mutable_only))
            identities.update(_container_ids(item, mutable_only=mutable_only))
        return identities
    if isinstance(value, (list, tuple, set)):
        identities = set() if mutable_only and isinstance(value, tuple) else {id(value)}
        for item in value:
            identities.update(_container_ids(item, mutable_only=mutable_only))
        return identities
    return set()


def _invalidate_bindings(names: dict[str, Any], targets: set[str]) -> None:
    invalid_ids = set().union(*(_container_ids(names[name]) for name in targets if name in names))
    for name, value in list(names.items()):
        if name in targets or _container_ids(value) & invalid_ids:
            names.pop(name)


def _invalidate_call_bindings(call: ast.Call, names: dict[str, Any]) -> bool:
    function = call.func
    function_name = (
        function.id
        if isinstance(function, ast.Name)
        else function.attr
        if isinstance(function, ast.Attribute)
        else None
    )
    if function_name in HEADER_CONSUMER_CALLS:
        return False
    targets = {
        node.id
        for node in ast.walk(call)
        if isinstance(node, ast.Name) and node.id in names and _container_ids(names[node.id], mutable_only=True)
    }
    header_ids = _container_ids(names.get("data_headers"), mutable_only=True)
    updates_headers = any(
        _container_ids(names[name], mutable_only=True) & header_ids for name in targets if name in names
    )
    _invalidate_bindings(names, targets)
    return updates_headers


def _is_artifact_processor(function: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    for decorator in function.decorator_list:
        target = decorator.func if isinstance(decorator, ast.Call) else decorator
        name = target.id if isinstance(target, ast.Name) else target.attr if isinstance(target, ast.Attribute) else None
        if name in {"artifact_processor", "artifact_processor_streaming"}:
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
    declarations: list[tuple[Any, list[Any]]] = []
    for node in _assignments(function.body):
        if declarations and "data_headers" not in names:
            return None, "data_headers is mutated dynamically"
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            call = node.value
            handled = False
            if isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name):
                target_name = call.func.value.id
                target = names.get(target_name)
                if isinstance(target, list) and call.func.attr in {"append", "extend", "insert"}:
                    handled = True
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
                        if updates_headers:
                            return None, "data_headers is mutated dynamically"
                        continue
                    if updates_headers:
                        for source, declaration in declarations:
                            if source is not target:
                                continue
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
                elif isinstance(target, (dict, list, set)):
                    handled = True
                    updates_headers = target is names.get("data_headers")
                    _invalidate_bindings(names, {target_name})
                    if updates_headers:
                        return None, "data_headers is mutated dynamically"
            if not handled and _invalidate_call_bindings(call, names):
                return None, "data_headers is mutated dynamically"
            continue

        if isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name):
            if node.target.id == "data_headers":
                return None, "data_headers is updated dynamically"
            if node.target.id in names:
                source = names[node.target.id]
                updates_headers = source is names.get("data_headers")
                try:
                    value = _resolve(node.value, names)
                    if isinstance(node.op, ast.Add):
                        if isinstance(source, list):
                            additions = list(value)
                            source.extend(additions)
                            for declaration_source, declaration in declarations:
                                if declaration_source is source:
                                    declaration.extend(additions)
                        else:
                            names[node.target.id] = source + value
                except IndexError, KeyError, TypeError, ValueError:
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
                        updated = current if isinstance(current, list) else list(current)
                        index = _resolve(target.slice, names)
                        updated[index] = value
                        names[target_name] = updated
                        if updates_headers:
                            names["data_headers"] = updated
                            for position, (source, declaration) in enumerate(declarations):
                                if source is current:
                                    declaration[index] = value
                                    declarations[position] = (updated, declaration)
                except IndexError, KeyError, TypeError, ValueError:
                    target_names = {
                        target.value.id for target in subscript_targets if isinstance(target.value, ast.Name)
                    }
                    updates_headers = "data_headers" in names and any(
                        names[name] is names["data_headers"] for name in target_names if name in names
                    )
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
            declarations.append((names["data_headers"], list(names["data_headers"])))
            continue
        target_values: dict[str, Any] = {}
        try:
            resolved_value = _resolve(value, names)
        except IndexError, KeyError, TypeError, ValueError:
            target_names = set().union(*(_target_names(target) for target in targets))
            for name in target_names:
                names.pop(name, None)
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
                declarations.append((resolved, list(resolved)))
            else:
                names[name] = resolved

    if declarations and "data_headers" not in names:
        return None, "data_headers is mutated dynamically"
    if not declarations:
        for node in _returns(function.body):
            if isinstance(node.value, (ast.List, ast.Tuple)) and node.value.elts:
                try:
                    returned_headers = _resolve(node.value.elts[0], names)
                except IndexError, KeyError, TypeError, ValueError:
                    continue
                if isinstance(returned_headers, (list, tuple)):
                    declarations.append((returned_headers, list(returned_headers)))
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
                        declarations.append((helper_headers, list(helper_headers)))
        if not declarations:
            return None, "artifact processor does not declare data_headers"
    headers: list[Any] = []
    seen_headers: set[str] = set()
    for _, declaration in declarations:
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


def _artifact_metadata(tree: ast.Module, constants: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    declarations = [
        node
        for node in tree.body
        if isinstance(node, (ast.Assign, ast.AnnAssign))
        and any(
            isinstance(target, ast.Name) and target.id == "__artifacts_v2__"
            for target in (node.targets if isinstance(node, ast.Assign) else [node.target])
        )
    ]
    if len(declarations) != 1:
        if not declarations:
            processors = {
                node.name
                for node in tree.body
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and _is_artifact_processor(node)
            }
            if processors:
                return {name: {} for name in processors}, None
        return {}, "module must declare __artifacts_v2__ exactly once"
    artifacts = constants.get("__artifacts_v2__")
    if not isinstance(artifacts, dict):
        return {}, "__artifacts_v2__ is not a supported static dictionary"
    for name, metadata in artifacts.items():
        if not isinstance(name, str) or not isinstance(metadata, dict):
            return {}, "__artifacts_v2__ contains a non-static artifact declaration"
    return artifacts, None


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
        metadata, metadata_error = _artifact_metadata(tree, constants)
        if metadata_error is not None:
            errors.append(f"{relative_path}::__artifacts_v2__: {metadata_error}")
            continue
        no_output = {name for name, entry in metadata.items() if entry.get("output_types") == "none"}
        if no_output:
            no_output_artifacts[relative_path] = sorted(no_output)
        functions = {node.name: node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
        module_artifacts: dict[str, list[Any]] = {}
        for node in functions.values():
            artifact_name = node.name
            if artifact_name not in metadata:
                if _is_artifact_processor(node):
                    errors.append(f"{relative_path}::{artifact_name}: processor is missing from __artifacts_v2__")
                continue
            headers, error = _header_declaration(node, constants, functions, set())
            if error is not None:
                if artifact_name in no_output:
                    continue
                errors.append(f"{relative_path}::{artifact_name}: {error} [source-sha256:{_source_fingerprint(node)}]")
                continue
            if headers is None:
                if artifact_name in no_output:
                    continue
                errors.append(
                    f"{relative_path}::{artifact_name}: no static header declaration was resolved "
                    f"[source-sha256:{_source_fingerprint(node)}]"
                )
                continue
            module_artifacts[artifact_name] = headers

        for artifact_name in metadata:
            if artifact_name not in functions and artifact_name not in no_output:
                errors.append(f"{relative_path}::{artifact_name}: declared artifact has no processor function")

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


def _source_fingerprint(function: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    source = ast.dump(function, include_attributes=False)
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


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
    reviewed_exceptions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": 2,
        "ileapp_commit": commit,
        "modules": modules,
        "artifacts": artifacts,
        "no_output_artifacts": no_output_artifacts,
        "unresolved": sorted(unresolved),
        "reviewed_exceptions": reviewed_exceptions or [],
    }


def _apply_reviewed_exceptions(current: dict[str, Any], previous: dict[str, Any] | None) -> None:
    if previous is None:
        current["reviewed_exceptions"] = []
        return

    unresolved = set(current["unresolved"])
    retained = [
        exception for exception in previous.get("reviewed_exceptions", []) if exception["declaration"] in unresolved
    ]
    current["reviewed_exceptions"] = retained
    for exception in retained:
        module, artifact_declaration = exception["declaration"].split("::", 1)
        artifact = artifact_declaration.split(":", 1)[0]
        headers = current["artifacts"].setdefault(module, {}).setdefault(artifact, [])
        for header in exception["headers"]:
            if header not in headers:
                headers.append(header)


def _shards(
    modules: list[str],
    artifacts: dict[str, dict[str, list[Any]]],
    no_output_artifacts: dict[str, list[str]],
    unresolved: list[str],
    reviewed_exceptions: list[dict[str, Any]],
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

    for exception in sorted(reviewed_exceptions, key=lambda entry: entry["declaration"]):
        module, _ = exception["declaration"].split("::", 1)
        module_entries[module].setdefault("reviewed_exceptions", []).append(exception)

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
    if previous.get("schema_version") != current.get("schema_version"):
        changes.append(f"baseline schema changed: {previous.get('schema_version')} -> {current.get('schema_version')}")
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

    old_exceptions = {entry["declaration"]: entry for entry in previous.get("reviewed_exceptions", [])}
    new_exceptions = {entry["declaration"]: entry for entry in current.get("reviewed_exceptions", [])}
    for declaration in sorted(new_exceptions.keys() - old_exceptions.keys()):
        changes.append(f"reviewed exception added: {declaration}")
    for declaration in sorted(old_exceptions.keys() - new_exceptions.keys()):
        changes.append(f"reviewed exception removed: {declaration}")
    for declaration in sorted(old_exceptions.keys() & new_exceptions.keys()):
        if old_exceptions[declaration] != new_exceptions[declaration]:
            changes.append(f"reviewed exception changed: {declaration}")
    return changes


def _load_baseline(index_path: Path) -> dict[str, Any]:
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except OSError, UnicodeError, json.JSONDecodeError:
        raise ValueError("Could not read the reviewed iLEAPP source-header baseline.") from None
    if (
        not isinstance(index, dict)
        or index.get("schema_version") not in {1, 2}
        or not isinstance(index.get("ileapp_commit"), str)
        or not isinstance(index.get("shards"), dict)
    ):
        raise ValueError("The reviewed iLEAPP source-header index has an invalid structure.")

    modules: list[str] = []
    artifacts: dict[str, dict[str, list[Any]]] = {}
    no_output_artifacts: dict[str, list[str]] = {}
    unresolved: list[str] = []
    reviewed_exceptions: list[dict[str, Any]] = []
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
            module_exceptions = entry.get("reviewed_exceptions", [])
            if (
                not isinstance(module_artifacts, dict)
                or not isinstance(module_no_output, list)
                or not isinstance(module_unresolved, list)
                or not isinstance(module_exceptions, list)
            ):
                raise ValueError(f"The iLEAPP source-header shard {shard_name} has an invalid module entry.")
            modules.append(module)
            if module_artifacts:
                artifacts[module] = module_artifacts
            if module_no_output:
                no_output_artifacts[module] = module_no_output
            unresolved.extend(module_unresolved)
            for exception in module_exceptions:
                if (
                    not isinstance(exception, dict)
                    or not isinstance(exception.get("declaration"), str)
                    or not exception["declaration"].startswith(f"{module}::")
                    or not isinstance(exception.get("reason"), str)
                    or not exception["reason"].strip()
                    or not isinstance(exception.get("headers"), list)
                    or any(
                        not (
                            isinstance(header, str)
                            or isinstance(header, list)
                            and header
                            and all(isinstance(part, str) for part in header)
                        )
                        for header in exception["headers"]
                    )
                ):
                    raise ValueError(f"The iLEAPP source-header shard {shard_name} has an invalid reviewed exception.")
                reviewed_exceptions.append(exception)
    declarations = [entry["declaration"] for entry in reviewed_exceptions]
    if len(declarations) != len(set(declarations)):
        raise ValueError("The reviewed iLEAPP source-header baseline repeats a reviewed exception.")
    return {
        "schema_version": index["schema_version"],
        "ileapp_commit": index["ileapp_commit"],
        "modules": sorted(modules),
        "artifacts": artifacts,
        "no_output_artifacts": no_output_artifacts,
        "unresolved": sorted(unresolved),
        "reviewed_exceptions": sorted(reviewed_exceptions, key=lambda entry: entry["declaration"]),
    }


def _write_baseline(current: dict[str, Any], directory: Path = BASELINE_DIR) -> Path:
    shards = _shards(
        current["modules"],
        current["artifacts"],
        current["no_output_artifacts"],
        current["unresolved"],
        current.get("reviewed_exceptions", []),
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
        previous = _load_baseline(INDEX_PATH) if INDEX_PATH.exists() else None
        _apply_reviewed_exceptions(current, previous)
        reviewed_declarations = {exception["declaration"] for exception in current["reviewed_exceptions"]}
        unreviewed = [item for item in current["unresolved"] if item not in reviewed_declarations]
        if args.update_baseline:
            shard_count = len(
                _shards(
                    modules,
                    artifacts,
                    no_output_artifacts,
                    unresolved,
                    current["reviewed_exceptions"],
                )
            )
            index_path = _write_baseline(current)
            print(f"Updated {index_path.relative_to(REPOSITORY_ROOT)} and {shard_count} shards")
            if unreviewed:
                print(f"{len(unreviewed)} unreviewed declarations require an explicit source resolution:")
                print("\n".join(unreviewed))
                return 1
            return 0

        if previous is None:
            raise ValueError(
                "The reviewed iLEAPP source-header baseline is missing; use --update-baseline after review."
            )
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
        if unreviewed:
            print(f"{len(unreviewed)} unreviewed declarations require an explicit source resolution:")
            print("\n".join(unreviewed))
        if not changes:
            if unreviewed:
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
