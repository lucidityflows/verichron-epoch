"""Tests for source-based iLEAPP header inventory mechanics only."""

import json
from pathlib import Path

import pytest

from scripts.audit_ileapp_entity_headers import _load_baseline, _write_baseline, compare_baselines, scan_source


def test_scans_decorated_artifact_headers_without_executing_source(tmp_path: Path) -> None:
    artifacts = tmp_path / "scripts" / "artifacts"
    artifacts.mkdir(parents=True)
    (artifacts / "sample.py").write_text(
        "HEADERS = ['Timestamp', ('URL', 'url')]\n"
        "def shared(context):\n"
        "    data_headers = HEADERS\n"
        "    return data_headers, [], ''\n"
        "@artifact_processor\n"
        "def sample(context):\n"
        "    return shared(context)\n",
        encoding="utf-8",
    )

    modules, inventory, no_output, errors = scan_source(artifacts)

    assert modules == ["scripts/artifacts/sample.py"]
    assert inventory == {"scripts/artifacts/sample.py": {"sample": ["Timestamp", ["URL", "url"]]}}
    assert no_output == {}
    assert errors == []


def test_unions_headers_from_static_conditional_variants(tmp_path: Path) -> None:
    artifacts = tmp_path / "scripts" / "artifacts"
    artifacts.mkdir(parents=True)
    (artifacts / "sample.py").write_text(
        "@artifact_processor\n"
        "def sample(context):\n"
        "    if context:\n"
        "        data_headers = ['Older field']\n"
        "    else:\n"
        "        data_headers = ['Newer field']\n"
        "    return data_headers, [], ''\n",
        encoding="utf-8",
    )

    _, inventory, _, errors = scan_source(artifacts)

    assert inventory == {"scripts/artifacts/sample.py": {"sample": ["Older field", "Newer field"]}}
    assert errors == []


def test_tracks_static_header_mutations_and_helper_constructors(tmp_path: Path) -> None:
    artifacts = tmp_path / "scripts" / "artifacts"
    artifacts.mkdir(parents=True)
    (artifacts / "sample.py").write_text(
        "SOURCE = 'Source'\n"
        "@artifact_processor\n"
        "def sample(context):\n"
        "    headers = ['Created']\n"
        "    headers.append(SOURCE)\n"
        "    data_headers = tuple(headers)\n"
        "    data_headers[0] = (data_headers[0], 'datetime')\n"
        "    return data_headers, [], ''\n",
        encoding="utf-8",
    )

    _, inventory, _, errors = scan_source(artifacts)

    assert inventory == {"scripts/artifacts/sample.py": {"sample": [["Created", "datetime"], "Source"]}}
    assert errors == []


def test_resolves_static_headers_returned_from_parameterized_helpers(tmp_path: Path) -> None:
    artifacts = tmp_path / "scripts" / "artifacts"
    artifacts.mkdir(parents=True)
    (artifacts / "sample.py").write_text(
        "def report_rows(context, headers):\n"
        "    return headers, [], ''\n"
        "@artifact_processor\n"
        "def sample(context):\n"
        "    return report_rows(context, ('Timestamp', 'Message'))\n",
        encoding="utf-8",
    )

    _, inventory, _, errors = scan_source(artifacts)

    assert inventory == {"scripts/artifacts/sample.py": {"sample": ["Timestamp", "Message"]}}
    assert errors == []


def test_resolves_static_header_tuple_with_slice_and_does_not_mutate_constants(tmp_path: Path) -> None:
    artifacts = tmp_path / "scripts" / "artifacts"
    artifacts.mkdir(parents=True)
    (artifacts / "sample.py").write_text(
        "HEADERS = ('Timestamp', 'Latitude', 'Longitude')\n"
        "@artifact_processor\n"
        "def sample(context):\n"
        "    data_headers = (('Timestamp', 'datetime'),) + HEADERS[1:]\n"
        "    return data_headers, [], ''\n"
        "@artifact_processor\n"
        "def another(context):\n"
        "    return HEADERS, [], ''\n",
        encoding="utf-8",
    )

    _, inventory, _, errors = scan_source(artifacts)

    assert inventory == {
        "scripts/artifacts/sample.py": {
            "sample": [["Timestamp", "datetime"], "Latitude", "Longitude"],
            "another": ["Timestamp", "Latitude", "Longitude"],
        }
    }
    assert errors == []


def test_resolves_static_header_comprehensions_and_list_mutations(tmp_path: Path) -> None:
    artifacts = tmp_path / "scripts" / "artifacts"
    artifacts.mkdir(parents=True)
    (artifacts / "sample.py").write_text(
        "HEADERS = ('Creation Date', 'Bundle ID', 'Last Used Date')\n"
        "@artifact_processor\n"
        "def sample(context):\n"
        "    last_index = HEADERS.index('Last Used Date')\n"
        "    headers = [header for header in HEADERS[1:] if header != 'Last Used Date']\n"
        "    headers.insert(0, ('Last Used Date', 'datetime'))\n"
        "    headers.insert(last_index, ('Creation Date', 'datetime'))\n"
        "    return headers, [], ''\n",
        encoding="utf-8",
    )

    _, inventory, _, errors = scan_source(artifacts)

    assert inventory == {
        "scripts/artifacts/sample.py": {
            "sample": [["Last Used Date", "datetime"], "Bundle ID", ["Creation Date", "datetime"]]
        }
    }
    assert errors == []


def test_reports_new_removed_and_changed_headers() -> None:
    previous = {
        "modules": ["scripts/artifacts/old.py", "scripts/artifacts/sample.py"],
        "unresolved": [],
        "no_output_artifacts": {"scripts/artifacts/old.py": ["old_non_tabular"]},
        "artifacts": {
            "scripts/artifacts/old.py": {"old_artifact": ["Old"]},
            "scripts/artifacts/sample.py": {"sample": ["Timestamp", "Previous", ["Typed", "string"]]},
        },
    }
    current = {
        "modules": ["scripts/artifacts/sample.py", "scripts/artifacts/new.py"],
        "artifacts": {
            "scripts/artifacts/new.py": {"new_artifact": ["New"]},
            "scripts/artifacts/sample.py": {"sample": ["Timestamp", "Renamed", ["Typed", "date"]]},
        },
        "no_output_artifacts": {"scripts/artifacts/new.py": ["new_non_tabular"]},
        "unresolved": ["scripts/artifacts/new.py::dynamic"],
    }

    changes = compare_baselines(previous, current)

    assert changes == [
        "new module: scripts/artifacts/new.py",
        "removed module: scripts/artifacts/old.py",
        "new non-tabular artifact: scripts/artifacts/new.py::new_non_tabular",
        "removed non-tabular artifact: scripts/artifacts/old.py::old_non_tabular",
        "new artifact: scripts/artifacts/new.py::new_artifact (1 headers)",
        "removed artifact: scripts/artifacts/old.py::old_artifact",
        "added header: scripts/artifacts/sample.py::sample :: Renamed",
        "removed header: scripts/artifacts/sample.py::sample :: Previous (possible rename)",
        "changed declaration: scripts/artifacts/sample.py::sample :: Typed",
        "unresolved declaration added: scripts/artifacts/new.py::dynamic",
    ]


def test_writes_reproducible_alphabetical_shards_and_index(tmp_path: Path) -> None:
    baseline = {
        "schema_version": 1,
        "ileapp_commit": "a" * 40,
        "modules": ["scripts/artifacts/alpha.py", "scripts/artifacts/beta.py"],
        "artifacts": {
            "scripts/artifacts/alpha.py": {"alpha": ["A"]},
            "scripts/artifacts/beta.py": {"beta": ["B"]},
        },
        "no_output_artifacts": {},
        "unresolved": ["scripts/artifacts/beta.py::dynamic"],
    }

    index_path = _write_baseline(baseline, tmp_path)

    assert index_path.name == "index.json"
    assert set(json.loads(index_path.read_text(encoding="utf-8"))["shards"]) == {"a.json", "b.json"}
    assert _load_baseline(index_path) == baseline


def test_splits_large_initial_groups_into_bounded_shards(tmp_path: Path) -> None:
    modules = [f"scripts/artifacts/alpha{index:02}.py" for index in range(13)]
    baseline = {
        "schema_version": 1,
        "ileapp_commit": "a" * 40,
        "modules": modules,
        "artifacts": {module: {"sample": ["Header"]} for module in modules},
        "no_output_artifacts": {},
        "unresolved": [],
    }

    index_path = _write_baseline(baseline, tmp_path)

    assert set(json.loads(index_path.read_text(encoding="utf-8"))["shards"]) == {
        "a-01.json",
        "a-02.json",
    }
    assert _load_baseline(index_path) == baseline


@pytest.mark.parametrize(
    ("source", "expected_error"),
    [
        (
            "@artifact_processor\n"
            "def sample(context):\n"
            "    data_headers = build_headers()\n"
            "    return data_headers, [], ''\n",
            "not a supported static expression",
        ),
        (
            "@artifact_processor\n"
            "def sample(context):\n"
            "    data_headers = ['One']\n"
            "    data_headers.append(context)\n"
            "    return data_headers, [], ''\n",
            "mutated dynamically",
        ),
        (
            "@artifact_processor\n"
            "def sample(context):\n"
            "    data_headers = ['One']\n"
            "    data_headers[0] = context\n"
            "    return data_headers, [], ''\n",
            "mutated dynamically",
        ),
    ],
)
def test_fails_on_unresolved_header_declarations(tmp_path: Path, source: str, expected_error: str) -> None:
    artifacts = tmp_path / "scripts" / "artifacts"
    artifacts.mkdir(parents=True)
    (artifacts / "sample.py").write_text(source, encoding="utf-8")

    _, _, _, errors = scan_source(artifacts)

    assert len(errors) == 1
    assert expected_error in errors[0]


def test_does_not_require_headers_for_declared_no_output_artifact(tmp_path: Path) -> None:
    artifacts = tmp_path / "scripts" / "artifacts"
    artifacts.mkdir(parents=True)
    (artifacts / "sample.py").write_text(
        "__artifacts_v2__ = {'sample': {'output_types': 'none'}}\n"
        "@artifact_processor\n"
        "def sample(context):\n"
        "    return None\n",
        encoding="utf-8",
    )

    modules, inventory, no_output, errors = scan_source(artifacts)

    assert modules == ["scripts/artifacts/sample.py"]
    assert inventory == {}
    assert no_output == {"scripts/artifacts/sample.py": ["sample"]}
    assert errors == []
