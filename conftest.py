"""
The repository's pytest setup. Before any test runs, a TEST_DATABASE_URL that
names the dev database, or a database not named as a test one, stops the run:
the real-Postgres tests empty the tables they use (2026-10-18, EPOCH-570).
"""

from __future__ import annotations

import os

import pytest
from testing.pg_real import TEST_DATABASE_URL_ENV, unsafe_test_database


def pytest_configure(config: pytest.Config) -> None:
    dsn = os.environ.get(TEST_DATABASE_URL_ENV)
    if dsn:
        reason = unsafe_test_database(dsn)
        if reason:
            pytest.exit(
                f"{TEST_DATABASE_URL_ENV} refused: {reason}. These tests empty the tables they use.", returncode=2
            )
