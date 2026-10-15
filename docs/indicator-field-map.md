# Indicator field map

Which facts can supply which indicator types, so that indicator matching
(EPOCH-491) knows where to look and can say what it couldn't check. The map is
declared once, in [`packages/contracts/indicator_field_map.json`](../packages/contracts/indicator_field_map.json),
and loaded by `indicator_field_map.py`. This page explains it. Established in
EPOCH-521.

## How sources were chosen

Facts come from crash reports, with top-level columns such as `process_name`
and `bundle_id`, and from iLEAPP, which keeps every value under its artifact's
own column headers. A source is a named column, chosen by what the column
holds. It is never chosen by value shape: on the reference backups, values
shaped like IP addresses were call durations, and values shaped like domains
were photo file names and type identifiers.

Every iLEAPP source names a column the pinned iLEAPP declares. The declared
columns of the mapped artifacts are recorded in
`packages/contracts/ileapp_schema/<iLEAPP commit>.json` by
`scripts/snapshot_ileapp_schema.py`, from real iLEAPP outputs. It refuses an
output whose `.ileapp_ok` marker doesn't name the pinned iLEAPP commit, since
iLEAPP's own version number is shared by several commits. A test fails if
the map names a column the pinned iLEAPP doesn't declare, or if the snapshot
belongs to another iLEAPP commit. Only the mapped artifacts are recorded: the
full list of artifacts in an output says which apps were on a device.

## Sources

Counts are values on the newest reference backup (2026-10-15, iPhone17,5,
iOS 26.6.1, iLEAPP 2026.3.0): counts only, never content. A source with no
values on this backup is still mapped. On such a case, its type is reported as
"source exists, but no facts" (EPOCH-491).

| Type | Source | Read as | Values |
|---|---|---|---:|
| URL | Safari Browser - History: URL, Redirect Source, Redirect Destination | as stored | 4,518; 509; 510 |
| URL | Safari Browser - Search Terms: URL, Redirect Source, Redirect Destination | as stored | 587; 0; 0 |
| URL | Safari Browser - Tabs (BrowserState): URL, User Visible URL | as stored | 199; 199 |
| URL | Safari Browser - Tabs (SafariTabs): URL | as stored | 25 |
| URL | Safari Browser - Bookmarks: URL | as stored | 2 |
| URL | iOS Screens: URL | as stored | 3 |
| Domain | the host of every URL source above | URL host | (from the URLs) |
| Domain | Cookies - Binary Cookies: Host | leading dot removed | 993 |
| Process name | crash report: `process_name` | as stored | 12 of 208 reports |
| Process name | Data Usage: Process Name | as stored | 3,416 |
| Bundle ID | crash report: `bundle_id` | as stored | 9 of 208 reports |
| Bundle ID | iTunes Backup - Installed Applications: Bundle ID | as stored | 52 |
| Bundle ID | Application State: Bundle ID | as stored | 189 |
| Bundle ID | Application Snapshot: Bundle ID | as stored | 262 |
| Bundle ID | Application Permissions: Bundle ID | as stored | 76 |
| Bundle ID | App Usage Events (AMDSQLiteDB): Bundle ID | as stored | 0 |
| Bundle ID | Data Usage: Bundle Name | as stored | 3,414 |
| Bundle ID | InteractionC - Contacts: Bundle ID | as stored | 7,722 |
| Bundle ID | interactionC Call History - Group Call: Application Bundle ID | as stored | 89 |
| Bundle ID | Files App - iCloud Application List: Application Bundle ID | as stored | 36 |
| Bundle ID | Files App - Files stored in iCloud Drive: Application Bundle ID | as stored | 127 |
| Bundle ID | Personalization Portrait - Locations: Bundle ID | as stored | 1,000 |
| Bundle ID | Account Data: Bundle ID | as stored | 15 |
| Email | SMS: Account Login, Account, Chat Contact ID | email addresses only, compared ignoring case | 1,872; 110; 92 |
| Email | Apple Recents: Contact Address, Sending Address | email addresses only, compared ignoring case | 15; 9 |
| Email | InteractionC - Contacts: Identifier | email addresses only, compared ignoring case | 1,276 |
| Email | Account Data: Username | email addresses only, compared ignoring case | 9 |
| Email | Calendar List: Account Email, Owner Email | email addresses only, compared ignoring case | 3; 3 |

**Not read:** URLs inside message text (SMS `Message`). Extracting them is its
own rule, with its own false-positive risk (EPOCH-491).

## Types with no source

| Type | Why |
|---|---|
| IP address | An iOS backup keeps no network connection log. |
| File hash, path, name | In the evidence manifest and the decrypt's `Manifest.db`, which aren't facts (EPOCH-523). |
| App signing certificate | Android indicators; an iOS backup holds none. |
| Android property | Android only. |
| Configuration profile | The pinned iLEAPP has no plugin that lists installed configuration profiles. |

## What the public feeds hold

The 19 STIX2 files that the mvt-indicators index lists (commit `b22ddf05`,
read 2026-10-15) hold 11,625 indicators. Every one is a single equality
comparison: no `IN`, no `AND`, no qualifiers, and none revoked.

| Type (STIX path) | Indicators | Supplied by a backup |
|---|---:|---|
| Domain (`domain-name:value`) | 6,692 | yes |
| File hash (`file:hashes.sha256`) | 3,461 | no (EPOCH-523) |
| Bundle ID (`app:id`) | 684 | yes |
| App certificate (`app:cert.sha1`, `app:cert.sha256`) | 497 | no |
| Process name (`process:name`) | 83 | yes |
| IP address (`ipv4-addr:value`) | 73 | no |
| Email (`email-addr:value`) | 65 | yes |
| File path, name (`file:path`, `file:name`) | 49, 15 | no (EPOCH-523) |
| Android property (`android-property:name`) | 3 | no |
| URL (`url:value`) | 2 | yes |
| Configuration profile (`configuration-profile:id`) | 1 | no |

By file, the iOS-relevant feeds rely mostly on domains:
- Pegasus: 1,438 domains, 81 process names, 29 emails and 1 file name.
- Predator: 569 domains, 13 file paths and 1 configuration profile.
- Operation Triangulation: 75 domains, 36 emails and 1 process name.

The largest file, stalkerware, is mostly Android: 3,228 file hashes, 652 bundle
IDs and 486 app certificates.
