#!/usr/bin/env python3
"""
Tests for ETLRunResult (extractors/etl_run.py).

The behavior under test is the one EXTRACTOR_CONTRACT.md section 5 is built
around: partial progress survives AND the stage still exits non-zero. Those two
requirements pull against each other, and the failure mode when they are
conflated is a stage that loses data and reports success — so the exit-code
rules get direct assertions rather than being implied by an integration test.
"""

from __future__ import annotations

import io

import pytest

from etl_run import ETLRunResult


def test_fresh_result_is_clean():
    result = ETLRunResult()

    assert result.succeeded == 0
    assert result.failed == 0
    assert result.exit_code == 0
    assert bool(result) is True


def test_a_stage_that_did_no_work_and_lost_nothing_succeeds():
    """An already-ingested backup is a fast no-op (contract section 3), not a
    failure. Zero records written must not be read as zero records survived."""
    assert ETLRunResult().exit_code == 0


def test_ok_accumulates_written_records():
    result = ETLRunResult()
    result.ok(5)
    result.ok(3)
    result.ok()  # defaults to one

    assert result.succeeded == 9
    assert result.exit_code == 0


def test_ok_rejects_negative_counts():
    with pytest.raises(ValueError):
        ETLRunResult().ok(-1)


def test_any_failure_forces_a_non_zero_exit_even_alongside_mass_success():
    """40,000 written and one lost is still a failed stage.

    exit_code derives from failures alone. "Mostly worked" is not an outcome a
    chain-of-custody tool reports as success; idempotency is what makes the
    re-run after a fix cheap.
    """
    result = ETLRunResult()
    result.ok(40_000)
    result.fail("history.csv[417]", "malformed row")

    assert result.succeeded == 40_000
    assert result.exit_code == 1
    assert bool(result) is False


def test_exceptions_are_rendered_with_their_type():
    """str(KeyError('timestamp')) is just "'timestamp'" — useless later."""
    result = ETLRunResult()
    result.fail("history.csv", KeyError("timestamp"))

    label, reason = result.failures[0]
    assert label == "history.csv"
    assert reason == "KeyError: 'timestamp'"


def test_string_reasons_pass_through():
    result = ETLRunResult()
    result.fail("sms.db", "table locked")

    assert result.failures[0] == ("sms.db", "table locked")


def test_merge_combines_both_sides():
    left = ETLRunResult().ok(5)
    left.fail("a.csv", "boom")
    right = ETLRunResult().ok(3)
    right.fail("b.csv", "bang")

    merged = left.merge(right)

    assert merged.succeeded == 8
    assert merged.failed == 2
    assert merged.exit_code == 1


def test_merge_does_not_mutate_either_operand():
    """Accumulating in a loop must not alias the accumulator to the increment."""
    accumulator = ETLRunResult().ok(1)
    increment = ETLRunResult().ok(2)

    accumulator.merge(increment)

    assert accumulator.succeeded == 1
    assert increment.succeeded == 2


def test_merge_result_is_independent_of_its_sources():
    source = ETLRunResult().ok(1)
    merged = source.merge(ETLRunResult())

    merged.ok(10)

    assert source.succeeded == 1


def test_merge_rejects_foreign_types():
    with pytest.raises(TypeError):
        ETLRunResult().merge((1, []))  # type: ignore[arg-type]


def test_summary_reports_counts_on_stdout(capsys):
    result = ETLRunResult().ok(12)

    result.print_summary("ileapp")

    out = capsys.readouterr().out
    assert "wrote 12 record(s)" in out
    assert "0 unit(s) failed" in out


def test_failure_detail_goes_to_stderr(capsys):
    """The orchestrator stores stderr as pipeline_stage_status.error_message,
    which is the field generate_report.py renders. Detail printed only to
    stdout never reaches the person reading the report."""
    result = ETLRunResult().ok(1)
    result.fail("history.csv[417]", "malformed row")

    result.print_summary("ileapp")

    captured = capsys.readouterr()
    assert "history.csv[417]" in captured.err
    assert "malformed row" in captured.err
    assert "history.csv[417]" not in captured.out


def test_itemized_failures_are_truncated_but_the_count_is_not():
    """A malformed 250k-row CSV can fail every row; the total must stay legible."""
    result = ETLRunResult()
    for index in range(250):
        result.fail(f"timeline.csv[{index}]", "bad row")

    stream = io.StringIO()
    result.print_summary("ileapp_bridge", stream=stream)
    rendered = stream.getvalue()

    assert "250 failure(s)" in rendered
    assert "and 230 more (truncated)" in rendered
    assert rendered.count("timeline.csv[") == 20
    assert result.failed == 250
