# Crash report fixtures

Real `.ips` files from the project owner's iPhone, copied with
`idevicecrashreport -k` (which leaves them on the device) on 2026-10-14 for
EPOCH-447, then redacted, because the repository is public.

| File | Bug type | Shape |
|---|---|---|
| `crash-json-body.ips` | 308 (MobileSafari) | metadata line, JSON body with `captureTime` |
| `json-body-no-body-time.ips` | 313 | metadata line, JSON body without a time |
| `text-body.ips` | 145 (mediaplaybackd, disk writes) | metadata line, text body, first 25 lines kept |
| `binary-body.ips` | 221 | metadata line, then a body that isn't UTF-8 |

**What was changed.** Identifiers (incident ids, `crashReporterKey`, UUIDs,
device and vendor identifiers, hex strings of 16 or more digits) are zeros;
every time is `2026-01-02 03:04:05` at `-0700`, keeping each value's format and
precision; process ids, `uptime` and similar counters are 1; JSON lists are
cut to their first three items; `session_start` and `country_code` were
replaced by hand. The binary file's body is 32 bytes chosen to be invalid
UTF-8 (`c8 00 ff 10`, repeated): the real body was not kept. Key names,
nesting, formats, bug types, OS versions and Apple's process names and paths
are as the device wrote them.

Of the 230 `.ips` files on the device, 212 had a JSON body, 16 a text body and
2 a binary one; every one had a JSON metadata line with a `timestamp`.
