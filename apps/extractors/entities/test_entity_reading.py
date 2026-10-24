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


def test_apple_podcasts_reads_feed_and_episode_urls():
    shows = read_unit(
        RULES,
        "ileapp_record",
        "Apple Podcasts Shows",
        {},
        [
            ileapp(
                5,
                "Apple Podcasts Shows",
                **{"Feed URL": "https://podcasts.example/feed", "Web Page URL": "https://shows.example/page"},
            )
        ],
    )
    episodes = read_unit(
        RULES,
        "ileapp_record",
        "Apple Podcasts Episodes",
        {},
        [
            ileapp(
                6,
                "Apple Podcasts Episodes",
                **{"Asset URL": "https://cdn.example/episode.mp3", "Web Page URL": "https://episodes.example/page"},
            )
        ],
    )

    assert set(shows.mentions) == {
        Mention(5, "url", "Feed URL", "https://podcasts.example/feed"),
        Mention(5, "domain", "Feed URL", "podcasts.example"),
        Mention(5, "url", "Web Page URL", "https://shows.example/page"),
        Mention(5, "domain", "Web Page URL", "shows.example"),
    }
    assert set(episodes.mentions) == {
        Mention(6, "url", "Asset URL", "https://cdn.example/episode.mp3"),
        Mention(6, "domain", "Asset URL", "cdn.example"),
        Mention(6, "url", "Web Page URL", "https://episodes.example/page"),
        Mention(6, "domain", "Web Page URL", "episodes.example"),
    }


def test_biome_app_intents_reads_only_explicit_bundle_and_url_fields():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "Biome - App Intents Transcript",
        {},
        [
            ileapp(
                21,
                "Biome - App Intents Transcript",
                **{"Bundle ID": "com.apple.shortcuts", "App URL": "https://maps.example/place"},
            )
        ],
    )

    assert set(reading.mentions) == {
        Mention(21, "app", "Bundle ID", "com.apple.shortcuts"),
        Mention(21, "url", "App URL", "https://maps.example/place"),
        Mention(21, "domain", "App URL", "maps.example"),
    }


def test_biome_proactive_harvesting_reads_mail_addresses_and_message_text():
    mail = read_unit(
        RULES,
        "ileapp_record",
        "Biome - Proactive Harvesting Mail",
        {},
        [
            ileapp(
                22,
                "Biome - Proactive Harvesting Mail",
                Sender="Sender <sender@example.org>",
                Recipient="recipient@example.net",
                Subject="See https://mail.example and contact help@example.com",
            )
        ],
    )
    message = read_unit(
        RULES,
        "ileapp_record",
        "Biome - Proactive Harvesting Messages",
        {},
        [ileapp(23, "Biome - Proactive Harvesting Messages", Content="Open https://chat.example")],
    )

    assert set(mail.mentions) == {
        Mention(22, "email", "Sender", "sender@example.org"),
        Mention(22, "email", "Recipient", "recipient@example.net"),
        Mention(22, "url", "Subject", "https://mail.example"),
        Mention(22, "domain", "Subject", "mail.example"),
        Mention(22, "email", "Subject", "help@example.com"),
    }
    assert set(message.mentions) == {
        Mention(23, "url", "Content", "https://chat.example"),
        Mention(23, "domain", "Content", "chat.example"),
    }


def test_biome_siri_contact_handle_is_not_classified_by_shape():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "Biome - Siri Remembers Call History",
        {},
        [ileapp(24, "Biome - Siri Remembers Call History", **{"Contact Handles": "contact@example.org"})],
    )

    assert reading.mentions == []
    assert reading.unread == {"Contact Handles": {"records": 1, "shaped": {"email": 1}}}


def test_biome_web_and_location_activity_read_explicit_urls_and_bundle_ids():
    web = read_unit(
        RULES,
        "ileapp_record",
        "Biome - App Web Usage",
        {},
        [
            ileapp(
                25,
                "Biome - App Web Usage",
                URL="https://web.example/page",
                Domain="web.example",
                **{"Bundle ID": "com.apple.mobilesafari"},
            )
        ],
    )
    location = read_unit(
        RULES,
        "ileapp_record",
        "Biome - App Location Activity",
        {},
        [
            ileapp(
                26,
                "Biome - App Location Activity",
                **{
                    "Bundle ID": "com.apple.Maps",
                    "URL": "https://maps.example/item",
                    "Place URL": "https://maps.example/place",
                },
            )
        ],
    )
    safari = read_unit(
        RULES,
        "ileapp_record",
        "Biome - Safari",
        {},
        [ileapp(30, "Biome - Safari", URL="https://history.example/page", Title="See https://title.example")],
    )
    location_activity = read_unit(
        RULES,
        "ileapp_record",
        "Biome - Location Activity",
        {},
        [ileapp(31, "Biome - Location Activity", **{"Bundle ID": "com.apple.Maps", "Bundle ID 2": "com.apple.Safari"})],
    )

    assert set(web.mentions) == {
        Mention(25, "url", "URL", "https://web.example/page"),
        Mention(25, "domain", "URL", "web.example"),
        Mention(25, "domain", "Domain", "web.example"),
        Mention(25, "app", "Bundle ID", "com.apple.mobilesafari"),
    }
    assert set(location.mentions) == {
        Mention(26, "app", "Bundle ID", "com.apple.maps"),
        Mention(26, "url", "URL", "https://maps.example/item"),
        Mention(26, "domain", "URL", "maps.example"),
        Mention(26, "url", "Place URL", "https://maps.example/place"),
        Mention(26, "domain", "Place URL", "maps.example"),
    }
    assert set(safari.mentions) == {
        Mention(30, "url", "URL", "https://history.example/page"),
        Mention(30, "domain", "URL", "history.example"),
        Mention(30, "url", "Title", "https://title.example"),
        Mention(30, "domain", "Title", "title.example"),
    }
    assert set(location_activity.mentions) == {
        Mention(31, "app", "Bundle ID", "com.apple.maps"),
        Mention(31, "app", "Bundle ID 2", "com.apple.safari"),
    }


def test_biome_wifi_reads_ssid_but_not_ambiguous_bluetooth_mac():
    wifi = read_unit(
        RULES,
        "ileapp_record",
        "Biome - WiFi Devices",
        {},
        [ileapp(27, "Biome - WiFi Devices", SSID="Lab Network")],
    )
    bluetooth = read_unit(
        RULES,
        "ileapp_record",
        "Biome - Bluetooth",
        {},
        [ileapp(28, "Biome - Bluetooth", MAC="AA:BB:CC:DD:EE:FF")],
    )

    assert wifi.mentions == [Mention(27, "wifi_network", "SSID", "Lab Network")]
    assert bluetooth.mentions == []
    assert bluetooth.unread["MAC"]["records"] == 1


def test_biome_network_prefix_is_not_an_ip_endpoint_entity():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "Biome - Networking Edge Selection",
        {},
        [ileapp(29, "Biome - Networking Edge Selection", **{"IP Address (Truncated)": "203.0.113.0"})],
    )

    assert reading.mentions == []
    assert reading.unread["IP Address (Truncated)"]["records"] == 1


def test_biome_system_events_read_explicit_app_and_dialed_number_fields():
    focus = read_unit(
        RULES,
        "ileapp_record",
        "Biome - In Focus DKEvent",
        {},
        [ileapp(32, "Biome - In Focus DKEvent", **{"Bundle ID": "com.apple.mobilesafari"})],
    )
    display = read_unit(
        RULES,
        "ileapp_record",
        "Biome - FrontBoard Display Element",
        {},
        [ileapp(33, "Biome - FrontBoard Display Element", **{"Bundle ID": "com.apple.Maps"})],
    )
    emergency = read_unit(
        RULES,
        "ileapp_record",
        "Biome - Emergency Voice Call",
        {},
        [ileapp(34, "Biome - Emergency Voice Call", **{"Emergency Number": "+1 (800) 555-0123"})],
    )

    assert focus.mentions == [Mention(32, "app", "Bundle ID", "com.apple.mobilesafari")]
    assert display.mentions == [Mention(33, "app", "Bundle ID", "com.apple.maps")]
    assert emergency.mentions == [Mention(34, "phone", "Emergency Number", "+18005550123")]


def test_notes_shared_participant_phone_is_a_named_phone_entity():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "Notes - Shared Note Participants",
        {},
        [ileapp(7, "Notes - Shared Note Participants", **{"Phone Number": "+1 (555) 555-0199"})],
    )

    assert reading.mentions == [Mention(7, "phone", "Phone Number", "+15555550199")]
    assert any(rule.kind == "phone" and rule.field == "Phone Number" for rule in reading.rules)


def test_address_book_reads_labeled_contact_urls():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "Address Book",
        {},
        [ileapp(9, "Address Book", URL="home: https://home.example/profile\r\nwork: https://work.example/")],
    )

    assert set(reading.mentions) == {
        Mention(9, "url", "URL", "https://home.example/profile"),
        Mention(9, "domain", "URL", "home.example"),
        Mention(9, "url", "URL", "https://work.example/"),
        Mention(9, "domain", "URL", "work.example"),
    }


def test_calendar_invitation_contacts_and_conference_url_are_read():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "Calendar Events",
        {},
        [
            ileapp(
                10,
                "Calendar Events",
                **{
                    "Invitation From": "Organizer - organizer@example.com",
                    "Invitees": "Guest - guest@example.net",
                    "Conference URL": "https://meet.example/room",
                },
            )
        ],
    )

    assert set(reading.mentions) == {
        Mention(10, "email", "Invitation From", "organizer@example.com"),
        Mention(10, "email", "Invitees", "guest@example.net"),
        Mention(10, "url", "Conference URL", "https://meet.example/room"),
        Mention(10, "domain", "Conference URL", "meet.example"),
    }


def test_apple_mail_reads_addresses_and_unsubscribe_links():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "Apple Email - Message Headers",
        {},
        [
            ileapp(
                11,
                "Apple Email - Message Headers",
                **{
                    "From Address": "Sender <sender@example.com>",
                    "To Address": "recipient@example.net",
                    "List Unsubscribe": "<mailto:leave@example.org>, <https://mail.example/unsubscribe>",
                },
            )
        ],
    )

    assert set(reading.mentions) == {
        Mention(11, "email", "From Address", "sender@example.com"),
        Mention(11, "email", "To Address", "recipient@example.net"),
        Mention(11, "email", "List Unsubscribe", "leave@example.org"),
        Mention(11, "url", "List Unsubscribe", "https://mail.example/unsubscribe"),
        Mention(11, "domain", "List Unsubscribe", "mail.example"),
    }


def test_reminder_title_and_notes_are_read_as_free_text():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "Reminders",
        {},
        [ileapp(12, "Reminders", Title="Visit https://clinic.example", Notes="Contact care@example.org")],
    )

    assert set(reading.mentions) == {
        Mention(12, "url", "Title", "https://clinic.example"),
        Mention(12, "domain", "Title", "clinic.example"),
        Mention(12, "email", "Notes", "care@example.org"),
    }


def test_account_username_is_not_read_as_an_email_from_its_shape():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "Account Data",
        {},
        [ileapp(13, "Account Data", Username="person@example.com")],
    )

    assert reading.mentions == []
    assert reading.unread == {"Username": {"records": 1, "shaped": {"email": 1}}}


def test_calendar_name_is_not_an_email_entity_just_because_it_has_email_shape():
    reading = read_unit(
        RULES,
        "ileapp_record",
        "Calendar List",
        {},
        [ileapp(8, "Calendar List", **{"Calendar Name": "person@example.com"})],
    )

    assert reading.mentions == []
    assert reading.unread == {"Calendar Name": {"records": 1, "shaped": {"email": 1}}}


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
