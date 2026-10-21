#!/usr/bin/env python3
"""Runs every entity rule against a real iLEAPP output (EPOCH-581).

    uv run python scripts/check_entity_rules.py <iLEAPP output dir>

For each rule it prints how many values its field held, how many were read
as the rule's kind, how many were the other kind of a handle field, and how
many didn't fit (unreadable). It names any rule whose artifact the output has
but whose field it doesn't: a renamed header in a new iLEAPP silently drops a
rule, so this is run on every iLEAPP update. Then, per kind, the artifacts the
output holds that the rules cover.

Counts only: no value from the evidence is printed. The artifacts an output
holds say which apps were on the device, so this output is case content and
never belongs in the repository.

Crash-report rules read the crash stage's records, not iLEAPP's output, and
are not checked here.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from entity_normalize import read
from entity_rules import EntityRules, Rule, load

MANIFEST = "_lava_data.lava"
DATABASE = "_lava_artifacts.db"


@dataclass
class Tally:
    values: int = 0
    read: int = 0
    other_kind: int = 0
    unreadable: int = 0
    distinct: set[str] = field(default_factory=set)


def read_rule(rules: EntityRules, rule: Rule, values: list[object]) -> tuple[Tally, Tally | None]:
    """Reads a field's values as one rule does: its kind, and the kind each value also yields."""
    kind = rules.kinds[rule.kind]
    also = rules.kinds[kind.also].normalize if kind.also else None
    tally, also_tally = Tally(), Tally() if also else None
    for raw in values:
        reading = read(rule.extract, kind.normalize, raw, also)
        if reading.other_kind:
            tally.values += 1
            tally.other_kind += 1
            continue
        tally.values += len(reading.values) + reading.unreadable
        tally.read += len(reading.values)
        tally.unreadable += reading.unreadable
        tally.distinct.update(reading.values)
        if also_tally is not None:
            also_tally.values += len(reading.also) + reading.also_unreadable
            also_tally.read += len(reading.also)
            also_tally.unreadable += reading.also_unreadable
            also_tally.distinct.update(reading.also)
    return tally, also_tally


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("output", type=Path, help="an iLEAPP output directory (holding _lava_data.lava)")
    args = parser.parse_args()
    manifest = json.loads((args.output / MANIFEST).read_text(encoding="utf-8"))
    # Read-only and immutable: checking never changes the evidence's derivative.
    conn = sqlite3.connect(f"file:{args.output / DATABASE}?mode=ro&immutable=1", uri=True)
    rules = load()

    artifacts = {entry["name"]: entry for entries in manifest["artifacts"].values() for entry in entries}
    declared: list[Rule] = []
    for name, entry in artifacts.items():
        types = {c["name"]: c["type"] for c in entry.get("object_columns") or []}
        for column, header in (entry.get("column_map") or {}).items():
            kind = rules.declared_types.get(types.get(column, ""))
            if kind:
                declared.append(Rule(kind=kind, source_type="ileapp_record", artifact=name, field=header))

    print(
        f"iLEAPP {manifest.get('parser_info', {}).get('leapp_version')}: {len(artifacts)} artifacts; "
        f"entity rules version {rules.version}: {len(rules.rules)} rules, {len(declared)} from declared types\n"
    )
    missing: list[Rule] = []
    dropped: list[Rule] = []
    absent = 0
    by_kind: dict[str, Tally] = defaultdict(Tally)
    covered: dict[str, set[str]] = defaultdict(set)
    rows: list[tuple[str, str, str, Tally]] = []
    seen: set[tuple[str, str | None, str]] = set()
    for rule in [*rules.rules, *declared]:
        if rule.source_type != "ileapp_record" or rule.artifact is None:
            continue
        if (rule.kind, rule.artifact, rule.field) in seen:
            continue
        seen.add((rule.kind, rule.artifact, rule.field))
        entry = artifacts.get(rule.artifact)
        if entry is None:
            absent += 1
            continue
        by_header = {header: column for column, header in (entry.get("column_map") or {}).items()}
        column = by_header.get(rule.field)
        if column is None:
            (dropped if rule.dropped_when_empty else missing).append(rule)
            continue
        values = [row[0] for row in conn.execute(f'SELECT "{column}" FROM "{entry["tablename"]}"')]
        tally, also_tally = read_rule(rules, rule, values)
        found = [(rule.kind, rule.field, tally)]
        also = rules.kinds[rule.kind].also
        if also and also_tally is not None:
            found.append((also, f"{rule.field} (host)", also_tally))
        for kind, name, t in found:
            rows.append((kind, rule.artifact, name, t))
            covered[kind].add(rule.artifact)
            total = by_kind[kind]
            total.values += t.values
            total.read += t.read
            total.other_kind += t.other_kind
            total.unreadable += t.unreadable
            total.distinct |= t.distinct

    print(f"{'kind':<18} {'artifact :: field':<78} {'values':>7} {'read':>7} {'other':>6} {'unfit':>6}")
    for kind, artifact, name, t in sorted(rows):
        flag = "  <- check" if t.values and t.unreadable / t.values > 0.1 else ""
        where = (artifact + " :: " + name)[:78]
        print(f"{kind:<18} {where:<78} {t.values:>7} {t.read:>7} {t.other_kind:>6} {t.unreadable:>6}{flag}")

    print(f"\n{'kind':<18} {'artifacts covered':>17} {'values read':>12} {'distinct':>9} {'unfit':>6}")
    for kind in rules.kinds:
        t = by_kind.get(kind, Tally())
        print(f"{kind:<18} {len(covered.get(kind, ())):>17} {t.read:>12} {len(t.distinct):>9} {t.unreadable:>6}")

    with_rows = {name for name, entry in artifacts.items() if entry.get("record_count")}
    any_rule = set().union(*covered.values()) if covered else set()
    print(
        f"\nArtifacts with records: {len(with_rows)}; covered by at least one rule: {len(with_rows & any_rule)}; "
        f"not covered by any: {len(with_rows - any_rule)}"
    )
    print(f"Rules whose artifact this output doesn't hold: {absent}")
    print(f"Rules whose field the artifact left out, as it does when no record holds a value: {len(dropped)}")
    if missing:
        print(f"\nRules whose artifact this output holds, without the field ({len(missing)}): fix these")
        for rule in missing:
            print(f"  {rule.kind}: {rule.artifact} :: {rule.field}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
