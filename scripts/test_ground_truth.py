"""Ground-truth label validation and lead scoring; fixtures here are synthetic mechanics tests only."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from scripts.eval.ground_truth import score_leads, validate_labels


def label(label_id: str, record_ref: str, **overrides: str) -> dict[str, str]:
    return {
        "label_id": label_id,
        "record_ref": record_ref,
        "timestamp_utc": "2026-01-02T03:04:05Z",
        "process": "example.process",
        "category": "network",
        "anomaly": "example anomaly",
        "verification": "Synthetic test fixture; no evidence reviewed.",
        **overrides,
    }


def labels(*entries: dict[str, str]) -> dict[str, object]:
    return {"schema_version": 1, "labels": list(entries)}


def test_accepts_complete_utc_labels() -> None:
    assert validate_labels(labels(label("test-1", "record-1", timestamp_utc="2026-01-02T03:04:05.123Z"))) == [
        label("test-1", "record-1", timestamp_utc="2026-01-02T03:04:05.123Z")
    ]


@pytest.mark.parametrize(
    "changes",
    [
        {"timestamp_utc": "2026-01-02T03:04:05+00:00"},
        {"timestamp_utc": "2026-01-02T03:04:05"},
        {"timestamp_utc": "2026-13-45T03:04:05Z"},
        {"timestamp_utc": "2025-02-29T03:04:05Z"},
        {"process": "  "},
        {"category": "unknown"},
        {"verification": ""},
        {"extra": "unexpected"},
    ],
)
def test_rejects_incomplete_or_non_utc_labels(changes: dict[str, str]) -> None:
    with pytest.raises(ValueError, match="values are omitted"):
        validate_labels(labels(label("test-1", "record-1", **changes)))


def test_rejects_duplicate_label_ids() -> None:
    with pytest.raises(ValueError, match="duplicate label IDs"):
        validate_labels(labels(label("same", "record-1"), label("same", "record-2")))


def test_allows_multiple_labels_for_one_source_record() -> None:
    score = score_leads(
        labels(label("test-1", "record-1"), label("test-2", "record-1")),
        {"leads": [{"lead_id": "lead-1", "cited_record_refs": ["record-1"]}]},
    )
    assert score.labels == 1
    assert score.matched_labels == 1
    assert score.recall == 1.0


def test_scores_leads_by_cited_records_and_counts_each_lead_once() -> None:
    truth = labels(label("test-1", "record-1"), label("test-2", "record-2"))
    leads = {
        "leads": [
            {"lead_id": "lead-1", "cited_record_refs": ["record-1", "record-2"]},
            {"lead_id": "lead-2", "cited_record_refs": ["unlabelled-record"]},
        ]
    }

    score = score_leads(truth, leads)

    assert score.labels == 2
    assert score.leads == 2
    assert score.matched_labels == 2
    assert score.missed_labels == 0
    assert score.matched_leads == 1
    assert score.unmatched_leads == 1
    assert score.precision == 0.5
    assert score.recall == 1.0


def test_empty_leads_have_undefined_precision_and_zero_recall() -> None:
    score = score_leads(labels(label("test-1", "record-1")), {"leads": []})
    assert score.precision is None
    assert score.recall == 0.0


def test_rejects_invalid_lead_references() -> None:
    with pytest.raises(ValueError, match="leads.0.cited_record_refs"):
        score_leads(labels(label("test-1", "record-1")), {"leads": [{"lead_id": "lead-1", "cited_record_refs": []}]})


def test_cli_refuses_private_inputs_inside_the_repository() -> None:
    path_inside_repo = Path(__file__).parent / "ground-truth-private-test.json"
    result = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).parent / "eval" / "ground_truth.py"),
            "validate",
            "--labels",
            str(path_inside_repo),
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 2
    assert "outside the repository" in result.stderr
    assert "record-1" not in result.stderr


def test_cli_outputs_aggregate_counts_only(tmp_path: Path) -> None:
    labels_path = tmp_path / "private-labels.json"
    labels_path.write_text(json.dumps(labels(label("secret-label", "secret-record"))), encoding="utf-8")
    leads_path = tmp_path / "private-leads.json"
    leads_path.write_text(
        json.dumps({"leads": [{"lead_id": "private-lead", "cited_record_refs": ["secret-record"]}]}),
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).parent / "eval" / "ground_truth.py"),
            "score",
            "--labels",
            str(labels_path),
            "--leads",
            str(leads_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    assert '"matched_labels": 1' in result.stdout
    assert "secret" not in result.stdout
    assert "private" not in result.stdout
