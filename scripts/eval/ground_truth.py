#!/usr/bin/env python3
"""Validate private ground-truth labels and score AI lead citations locally."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

LABEL_SCHEMA_PATH = Path(__file__).with_name("ground_truth.schema.json")
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class LeadScore:
    labels: int
    leads: int
    matched_labels: int
    missed_labels: int
    matched_leads: int
    unmatched_leads: int
    precision: float | None
    recall: float


def _load_json(path: Path) -> Any:
    try:
        with path.open(encoding="utf-8") as source:
            return json.load(source)
    except OSError, UnicodeError, json.JSONDecodeError:
        raise ValueError("Could not read a private JSON input; details are omitted to protect case data.") from None


def _load_private_json(path: Path) -> Any:
    if path.resolve().is_relative_to(REPOSITORY_ROOT):
        raise ValueError("Private inputs must be outside the repository; case data is never read from the checkout.")
    return _load_json(path)


def _validate_without_values(document: Any, schema: dict[str, Any], input_name: str) -> None:
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    error = next(iter(validator.iter_errors(document)), None)
    if error is not None:
        location = ".".join(str(part) for part in error.absolute_path) or "document"
        raise ValueError(f"{input_name} is invalid at {location}; values are omitted to protect case data.")


def validate_labels(document: Any) -> list[dict[str, str]]:
    schema = _load_json(LABEL_SCHEMA_PATH)
    _validate_without_values(document, schema, "Ground-truth labels")
    labels: list[dict[str, str]] = document["labels"]
    label_ids = [label["label_id"] for label in labels]
    if len(set(label_ids)) != len(label_ids):
        raise ValueError("Ground-truth labels contain duplicate label IDs; values are omitted to protect case data.")
    for index, label in enumerate(labels):
        try:
            datetime.fromisoformat(label["timestamp_utc"][:-1] + "+00:00")
        except ValueError:
            raise ValueError(
                f"Ground-truth labels are invalid at labels.{index}.timestamp_utc; "
                "values are omitted to protect case data."
            ) from None
    return labels


def validate_leads(document: Any) -> list[dict[str, Any]]:
    if not isinstance(document, dict) or set(document) != {"leads"} or not isinstance(document["leads"], list):
        raise ValueError("Lead input must contain only a leads array; values are omitted to protect case data.")

    leads = document["leads"]
    lead_ids: set[str] = set()
    for index, lead in enumerate(leads):
        if not isinstance(lead, dict) or set(lead) != {"lead_id", "cited_record_refs"}:
            raise ValueError(
                f"Lead input is invalid at leads.{index}; expected lead_id and cited_record_refs, "
                "values are omitted to protect case data."
            )
        lead_id = lead["lead_id"]
        citations = lead["cited_record_refs"]
        if not isinstance(lead_id, str) or not lead_id.strip() or lead_id in lead_ids:
            raise ValueError(
                f"Lead input is invalid at leads.{index}.lead_id; values are omitted to protect case data."
            )
        if (
            not isinstance(citations, list)
            or not citations
            or any(not isinstance(reference, str) or not reference.strip() for reference in citations)
            or len(set(citations)) != len(citations)
        ):
            raise ValueError(
                f"Lead input is invalid at leads.{index}.cited_record_refs; values are omitted to protect case data."
            )
        lead_ids.add(lead_id)
    return leads


def score_leads(labels_document: Any, leads_document: Any) -> LeadScore:
    labels = validate_labels(labels_document)
    leads = validate_leads(leads_document)
    expected_refs = {label["record_ref"] for label in labels}
    cited_refs = {reference for lead in leads for reference in lead["cited_record_refs"]}
    matched_leads = sum(bool(expected_refs.intersection(lead["cited_record_refs"])) for lead in leads)
    matched_labels = len(expected_refs.intersection(cited_refs))
    return LeadScore(
        labels=len(expected_refs),
        leads=len(leads),
        matched_labels=matched_labels,
        missed_labels=len(expected_refs) - matched_labels,
        matched_leads=matched_leads,
        unmatched_leads=len(leads) - matched_leads,
        precision=matched_leads / len(leads) if leads else None,
        recall=matched_labels / len(expected_refs),
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate private ground-truth labels or score AI lead citations.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate", help="validate a private ground-truth JSON file")
    validate.add_argument("--labels", type=Path, required=True)

    score = subparsers.add_parser("score", help="score private lead citations against ground-truth labels")
    score.add_argument("--labels", type=Path, required=True)
    score.add_argument("--leads", type=Path, required=True)
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        labels = validate_labels(_load_private_json(args.labels))
        if args.command == "validate":
            result: dict[str, Any] = {"status": "valid", "labels": len(labels)}
        else:
            result = {
                "status": "scored",
                **asdict(score_leads({"schema_version": 1, "labels": labels}, _load_private_json(args.leads))),
            }
        print(json.dumps(result, sort_keys=True))
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
