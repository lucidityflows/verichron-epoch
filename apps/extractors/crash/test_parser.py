"""The .ips parser on redacted real crash reports, one per shape the reference
device produced (EPOCH-447; fixtures/README.md says how they were made)."""

from datetime import UTC, datetime
from pathlib import Path

from stored_value import decode_value

from crash.main import extract_rich_telemetry, parse_ips_file, telemetry_to_record

FIXTURES = Path(__file__).parent / "fixtures"
#: Every fixture's metadata timestamp, 2026-01-02 03:04:05.11 -0700.
METADATA_TIME = datetime(2026, 1, 2, 10, 4, 5, 110000, tzinfo=UTC)


def record_of(name: str):
    parsed, err = parse_ips_file(FIXTURES / name)
    assert err is None, err
    assert parsed is not None
    telemetry = extract_rich_telemetry(parsed)
    telemetry["filename"] = name
    return parsed, telemetry_to_record(telemetry)


def test_a_crash_report_with_a_json_body():
    parsed, record = record_of("crash-json-body.ips")
    assert parsed["body_format"] == "json"
    assert record.bug_type == "308"
    assert record.incident_id == "00000000-0000-0000-0000-000000000000"
    assert record.process_name == "MobileSafari"
    assert record.pid == 1
    assert record.bundle_id == "com.apple.mobilesafari"
    assert record.fields["exception"]["type"] == "EXC_GUARD"
    assert record.fields["termination"]["namespace"] == "WEBKIT"
    assert record.fields["hardware_model"] == "iPhone17,5"


def test_the_time_is_the_metadata_timestamp_and_the_body_time_is_kept():
    """One standard (EPOCH-447): every file has the metadata timestamp; a
    body's captureTime, where there is one, is kept beside it."""
    _, record = record_of("crash-json-body.ips")
    assert record.event_time == METADATA_TIME
    assert record.fields["time_source"] == "metadata timestamp"
    assert record.fields["body_time"] == "2026-01-02 03:04:05.1111 -0700"


def test_a_json_body_without_a_time_still_gets_the_metadata_time():
    parsed, record = record_of("json-body-no-body-time.ips")
    assert parsed["body_format"] == "json"
    assert record.bug_type == "313"
    assert record.event_time == METADATA_TIME
    assert record.fields["body_time"] is None


def test_a_text_body_is_kept_exactly_and_the_record_comes_from_the_metadata():
    parsed, record = record_of("text-body.ips")
    raw_body = (FIXTURES / "text-body.ips").read_bytes().partition(b"\n")[2].decode("utf-8")
    assert parsed["body_format"] == "text"
    assert parsed["body"] == raw_body
    assert record.bug_type == "145"
    assert record.process_name == "mediaplaybackd"
    assert record.event_time == METADATA_TIME
    assert record.fields["body_format"] == "text"


def test_a_binary_body_is_stored_encoded_and_decodes_to_the_same_bytes():
    parsed, record = record_of("binary-body.ips")
    raw_body = (FIXTURES / "binary-body.ips").read_bytes().partition(b"\n")[2]
    assert parsed["body_format"] == "binary"
    assert decode_value(parsed["body"]) == raw_body
    assert record.bug_type == "221"
    assert record.event_time == METADATA_TIME


def test_a_file_without_a_json_metadata_line_is_an_error(tmp_path):
    for content in (b"not json\n{}", b"\xc8\xff\n{}", b'["a list"]\n{}', b""):
        path = tmp_path / "bad.ips"
        path.write_bytes(content)
        parsed, err = parse_ips_file(path)
        assert parsed is None
        assert err
