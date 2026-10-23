"""What one unit's records mention, with no database (EPOCH-581). The values
are made up in the shapes iLEAPP and the crash stage store; none comes from
evidence."""

from __future__ import annotations

from db_writer import Mention
from entity_reading import Record, read_unit, rules_for
from entity_rules import load

RULES = load()


def ileapp(record_id: int, artifact: str, **row) -> Record:
    return Record(
        record_id,
        {},
        {"engine": "iLEAPP", "source_artifact": artifact, "module": "m", "category": "c", "source_path": "p", **row},
    )


def test_a_url_is_read_with_its_host_under_the_field_it_came_from():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "Safari Browser - History",
        {},
        [ileapp(1, "Safari Browser - History", URL="HTTPS://Example.COM/a", Title="A page")],
    )
    assert Mention(1, "url", "URL", "https://example.com/a") in reading.mentions
    assert Mention(1, "domain", "URL", "example.com") in reading.mentions


def test_wifi_known_networks_reads_portal_urls_and_bundle_ids():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "WiFi Known Networks Info",
        {},
        [
            ileapp(
                2,
                "WiFi Known Networks Info",
                **{"User Portal URL": "https://portal.example/login", "Bundle ID": "com.apple.settings"},
            )
        ],
    )
    assert set(reading.mentions) == {
        Mention(2, "url", "User Portal URL", "https://portal.example/login"),
        Mention(2, "domain", "User Portal URL", "portal.example"),
        Mention(2, "app", "Bundle ID", "com.apple.settings"),
    }


def test_photos_icloud_records_read_explicit_app_url_email_and_phone_fields():
    artifact = "Ph126.1-iOS26_Ref_for_Asset_Analysis-PhDaPsql"
    fields = {
        "SWYzGenAlbum-Imported by Bundle Identifier-495": "com.apple.photos",
        "zShare-Client BundleID-CMM-368": "com.apple.photos.shared",
        "SPLzShare-Client BundleID-SPL-369": "com.apple.photos.sharedlibrary",
        "zShare-Share URL-CMM-366": "https://share.example/cmm",
        "SPLzShare-Share URL-SPL-367": "https://share.example/spl",
        "zGenAlbum-Public URL-596": "https://public.example/album",
        "SWYConverszGenAlbum-Public URL-598": "https://public.example/shared",
        "zEdIPTCAttr-CiURLWork-1005": "https://contact.example/",
        "zSharePartic-Email Address-462": "cmm@example.com",
        "SPLzSharePartic-Email Address-463": "spl@example.com",
        "zEdIPTCAttr-CiEmailWork-1003": "work@example.com",
        "zSharePartic-Phone Number-464": "+15555550101",
        "SPLzSharePartic-Phone Number-465": "+15555550102",
        "zEdIPTCAttr-CiTeLWork-1004": "+15555550103",
    }
    reading = read_unit(RULES, "ileapp_record", artifact, {}, [ileapp(3, artifact, **fields)])

    assert set(reading.mentions) == {
        Mention(3, "app", "SWYzGenAlbum-Imported by Bundle Identifier-495", "com.apple.photos"),
        Mention(3, "app", "zShare-Client BundleID-CMM-368", "com.apple.photos.shared"),
        Mention(3, "app", "SPLzShare-Client BundleID-SPL-369", "com.apple.photos.sharedlibrary"),
        Mention(3, "url", "zShare-Share URL-CMM-366", "https://share.example/cmm"),
        Mention(3, "domain", "zShare-Share URL-CMM-366", "share.example"),
        Mention(3, "url", "SPLzShare-Share URL-SPL-367", "https://share.example/spl"),
        Mention(3, "domain", "SPLzShare-Share URL-SPL-367", "share.example"),
        Mention(3, "url", "zGenAlbum-Public URL-596", "https://public.example/album"),
        Mention(3, "domain", "zGenAlbum-Public URL-596", "public.example"),
        Mention(3, "url", "SWYConverszGenAlbum-Public URL-598", "https://public.example/shared"),
        Mention(3, "domain", "SWYConverszGenAlbum-Public URL-598", "public.example"),
        Mention(3, "url", "zEdIPTCAttr-CiURLWork-1005", "https://contact.example/"),
        Mention(3, "domain", "zEdIPTCAttr-CiURLWork-1005", "contact.example"),
        Mention(3, "email", "zSharePartic-Email Address-462", "cmm@example.com"),
        Mention(3, "email", "SPLzSharePartic-Email Address-463", "spl@example.com"),
        Mention(3, "email", "zEdIPTCAttr-CiEmailWork-1003", "work@example.com"),
        Mention(3, "phone", "zSharePartic-Phone Number-464", "+15555550101"),
        Mention(3, "phone", "SPLzSharePartic-Phone Number-465", "+15555550102"),
        Mention(3, "phone", "zEdIPTCAttr-CiTeLWork-1004", "+15555550103"),
    }


def test_photos_metadata_reads_creator_bundle_id_as_an_app():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "Photos.sqlite Metadata",
        {},
        [ileapp(4, "Photos.sqlite Metadata", **{"Creator Bundle ID": "com.apple.camera"})],
    )
    assert reading.mentions == [Mention(4, "app", "Creator Bundle ID", "com.apple.camera")]


def test_free_text_yields_urls_emails_and_ips_but_never_phone_numbers():
    message = "Call +1 555 555 0123, see https://example.org/x. Mail someone@example.com from 192.0.2.7."
    reading = read_unit(RULES, "ileapp_record", "SMS", {}, [ileapp(7, "SMS", Message=message)])
    found = {(m.kind, m.normalized_value) for m in reading.mentions if m.role == "Message"}
    assert found == {
        ("url", "https://example.org/x"),
        ("domain", "example.org"),
        ("email", "someone@example.com"),
        ("ip", "192.0.2.7"),
    }


def test_a_column_ileapp_declares_a_phone_number_is_read_without_a_named_rule():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "An Artifact With No Rule",
        {"Number": "phonenumber", "Note": None},
        [ileapp(3, "An Artifact With No Rule", Number="+1 (555) 555-0199", Note="text")],
    )
    assert reading.mentions == [Mention(3, "phone", "Number", "+15555550199")]
    assert reading.unread == {"Note": {"records": 1, "shaped": {}}}


def test_a_named_rule_takes_the_place_of_the_declared_type_for_the_same_field():
    unit_rules = rules_for(RULES, "ileapp_record", "Address Book", {"Phone Numbers": "phonenumber"})
    phones = [r for r in unit_rules if r.field == "Phone Numbers"]
    assert [r.extract for r in phones] == ["labelled_list"]


def test_every_field_no_rule_reads_is_listed_with_how_many_records_held_a_value():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "Safari Browser - History",
        {},
        [
            ileapp(1, "Safari Browser - History", URL="https://example.com/", **{"Visit Count": 3}),
            ileapp(2, "Safari Browser - History", URL="https://example.com/", **{"Visit Count": ""}),
        ],
    )
    # The stage's own metadata is not a field of the row; an empty value is not a value.
    assert reading.unread == {"Visit Count": {"records": 1, "shaped": {}}}


def test_a_crash_report_is_read_from_its_record_columns():
    record = Record(
        9,
        {"incident_id": "x", "bug_type": "309", "process_name": "ExampleApp", "pid": 4, "bundle_id": "com.example.app"},
        {"filename": "ExampleApp.ips"},
    )
    reading = read_unit(RULES, "crash_report", None, {}, [record])
    assert set(reading.mentions) == {
        Mention(9, "app", "bundle_id", "com.example.app"),
        Mention(9, "process", "process_name", "ExampleApp"),
    }
    assert {name: entry["records"] for name, entry in reading.unread.items()} == {
        "incident_id": 1,
        "bug_type": 1,
        "pid": 1,
        "filename": 1,
    }


def test_values_that_dont_fit_or_are_another_kind_are_counted_not_stored():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "InteractionC - Contacts",
        {},
        [
            ileapp(1, "InteractionC - Contacts", **{"Display Name": "Alex Example"}),
            ileapp(2, "InteractionC - Contacts", **{"Display Name": "+15555550123"}),
        ],
    )
    phone = next(c for c in reading.rules if c.kind == "phone" and c.field == "Display Name")
    assert (phone.read, phone.other_kind, phone.unreadable) == (1, 1, 0)
    assert [m.normalized_value for m in reading.mentions if m.kind == "phone"] == ["+15555550123"]


def test_the_summary_says_what_was_read_by_kind_and_what_was_not():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "Safari Browser - History",
        {},
        [ileapp(1, "Safari Browser - History", URL="https://example.com/a", **{"Visit Count": 3})],
    )
    summary = reading.summary({"ingest_id": 1})
    assert summary["mentions"] == 2
    assert summary["by_kind"] == {"domain": 1, "url": 1}
    assert summary["unread_fields"] == {"Visit Count": {"records": 1, "shaped": {}}}
    url = next(r for r in summary["rules"] if r["kind"] == "url" and r["field"] == "URL")
    assert (url["read"], url["distinct"], url["also_read"]) == (1, 1, 1)


def test_a_field_no_rule_reads_is_ranked_by_the_shapes_its_values_have():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "An Artifact With No Rule",
        {},
        [
            ileapp(1, "An Artifact With No Rule", Handle="+15555550123", Blob="see https://example.com/x"),
            ileapp(2, "An Artifact With No Rule", Handle="Alex Example", Blob="com.example.app"),
            ileapp(3, "An Artifact With No Rule", Handle="+15555550124", Blob="version 1.2.3.4.5"),
        ],
    )
    assert reading.unread["Handle"] == {"records": 3, "shaped": {"phone": 2}}
    assert reading.unread["Blob"] == {"records": 3, "shaped": {"bundle_id": 1, "url": 1}}
