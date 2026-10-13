#!/usr/bin/env python3
"""
CI guard: fails if raw source_type string literals are found outside packages/contracts/.

Usage: python scripts/check_source_type_literals.py
Exit code 1 if violations found.
"""
import re
import sys
from pathlib import Path

# Canonical values — update this list whenever SourceType enum grows
LITERAL_VALUES = [
    "crash_report",
    "ileapp_record",
    "safari_history",
    "sms_message",
    "call_history",
    "contacts",
]

# Directories to scan
SCAN_EXTENSIONS = {".py", ".ts", ".tsx"}

# Paths that ARE allowed to contain these literals (the definitions themselves)
ALLOWLIST = [
    Path("packages/contracts"),
    Path("scripts/check_source_type_literals.py"),
]

# Pattern: the literal in quotes, as a value (not e.g. a URL slug or comment)
PATTERN = re.compile(
    r"""(['"])(%s)\1""" % "|".join(re.escape(v) for v in LITERAL_VALUES)
)

ROOT = Path(__file__).parent.parent
violations: list[str] = []

for path in ROOT.rglob("*"):
    if path.suffix not in SCAN_EXTENSIONS:
        continue
    if any(path.is_relative_to(ROOT / a) for a in ALLOWLIST):
        continue
    # Skip node_modules, .venv, __pycache__, dist
    if any(p in path.parts for p in ("node_modules", ".venv", "__pycache__", "dist", ".git")):
        continue

    text = path.read_text(encoding="utf-8", errors="ignore")
    for lineno, line in enumerate(text.splitlines(), 1):
        if PATTERN.search(line):
            violations.append(f"  {path.relative_to(ROOT)}:{lineno}  →  {line.strip()}")

if violations:
    print("❌  Raw source_type string literals found outside packages/contracts/:")
    print("    Replace these with SourceType.<VALUE> from packages/contracts\n")
    print("\n".join(violations))
    sys.exit(1)

print(f"✅  No raw source_type literals found ({len(list(ROOT.rglob('*')))} files scanned)")