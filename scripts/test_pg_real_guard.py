"""The test database guard gives the shared cases' results (EPOCH-570, R4).

The cases are packages/contracts/test-database-vectors.json, which the
TypeScript guard's tests read too.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from testing.pg_real import database_refusal, dev_database_from_env, safe_test_database_url

VECTORS = json.loads(
    (Path(__file__).resolve().parents[1] / "packages" / "contracts" / "test-database-vectors.json").read_text()
)


@pytest.mark.parametrize("case", VECTORS["urls"], ids=lambda c: c["dsn"])
def test_each_url_is_accepted_or_refused_as_the_shared_cases_say(case):
    refusal = database_refusal(case["dsn"], case["dev"])
    assert (refusal[0] if refusal else None) == case["refused"]


@pytest.mark.parametrize("case", VECTORS["env"], ids=lambda c: c["text"].replace("\n", " | "))
def test_the_dev_database_is_read_from_env_as_the_shared_cases_say(case):
    assert dev_database_from_env(case["text"]) == case["dev"]


def test_a_refused_url_stops_before_any_table_is_touched(monkeypatch):
    monkeypatch.setenv("TEST_DATABASE_URL", "postgresql://u:p@localhost:5432/latest")
    with pytest.raises(RuntimeError, match="refused"):
        safe_test_database_url()
