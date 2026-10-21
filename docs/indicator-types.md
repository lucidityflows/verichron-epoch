# Indicator types

Which indicator types a check can compare, and with which kind of entity, so
that indicator matching (EPOCH-491) knows what to compare and can say what it
couldn't. Declared once, in
[`packages/contracts/indicator_types.json`](../packages/contracts/indicator_types.json),
and loaded by `indicator_types.py`. Since EPOCH-581 it replaces the indicator
field map of EPOCH-521: a check compares indicators with the
[entities](evidence-model.md#entities) the entities stage read from the
evidence's records, and which field holds which kind is declared once, in the
entity rules (`packages/contracts/entity_rules.json`). Its `stix_paths` are
also how the indicator loader (EPOCH-490) gives each STIX object path its
type: a path not listed there isn't loaded.

## Compared types

| Indicator type | STIX path | Entity kind | Compared |
|---|---|---|---|
| Domain | `domain-name:value` | `domain` (every rule's domain, and the host of every URL) | exactly, or as a subdomain on a label boundary, with the mode recorded |
| URL | `url:value` | `url` | exactly, on the normalized URL |
| Process name | `process:name` | `process` | exactly; case-sensitive |
| Bundle ID | `app:id` | `app` | exactly; case-insensitive |
| Email | `email-addr:value` | `email` | exactly; case-insensitive |
| IP address | `ipv4-addr:value` | `ip` (read from free text: SMS, Notes, page titles) | exactly |

Which fields each kind is read from, and what is deliberately not read, is in
the entity rules; each check states, with its result, the fields that held
values and that no rule reads, and any record not yet read for entities.

## Types with no source

| Type | Why |
|---|---|
| File hash, path, name | In the evidence manifest and the decrypt's `Manifest.db`, which aren't facts (EPOCH-523). |
| App signing certificate | Android indicators; an iOS backup holds none. |
| Android property | Android only. |
| Configuration profile | The pinned iLEAPP has no plugin that lists installed configuration profiles. |

IP addresses had no source under the field map: an iOS backup keeps no network
connection log, and values shaped like IP addresses in columns were call
durations. Since EPOCH-581 they are read from free text only, where a dotted
quad is checked as an address (2026-10-20: 6 in SMS on the reference backup).

## What the public feeds hold

The 19 STIX2 files that the mvt-indicators index lists (commit `b22ddf05`,
read 2026-10-15) hold 11,625 indicators. Every one is a single equality
comparison: no `IN`, no `AND`, no qualifiers, and none revoked.

| Type (STIX path) | Indicators | Compared |
|---|---:|---|
| Domain (`domain-name:value`) | 6,692 | yes |
| File hash (`file:hashes.sha256`) | 3,461 | no (EPOCH-523) |
| Bundle ID (`app:id`) | 684 | yes |
| App certificate (`app:cert.sha1`, `app:cert.sha256`) | 497 | no |
| Process name (`process:name`) | 83 | yes |
| IP address (`ipv4-addr:value`) | 73 | yes, from free text (EPOCH-581) |
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
