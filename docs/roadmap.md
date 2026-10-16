# Public roadmap

How the public roadmap is published from Linear, and the rules for what may
appear on it. The roadmap is for practising forensic examiners and for anyone
interested in the Lab Edition alpha. It shows *capabilities* in the examiner's
terms, never raw tickets.

The Linear workspace is private. Nothing leaves it except the fields listed
under [What is published](#what-is-published), and only for issues labelled
**Public**. The publisher is default-deny: an issue or field not explicitly
allowed is never published.

The decision to publish this way is recorded in
[decisions.md](decisions.md#product-and-builds) (EPOCH-471).

## Capability issues

A capability is something an examiner can do or rely on, such as "Pull an
encrypted backup from a connected iPhone". Each capability is one Linear issue:

- in the project it belongs to (for now, Verichron Epoch: Lab Edition 1.0);
- labelled **Public**, and exactly one **Lane** label;
- with no `EPOCH-` number, since a capability is not a unit of work;
- with a description that states what the capability means and what has to be
  true for it to count as **Shipped**. The description is internal and is
  never published.

The work is done in ordinary tickets, which are the capability's sub-issues.
A ticket belongs to at most one capability. Engineering tickets that don't
change what an examiner can do (CI, formatting, refactors) can have no
capability. Sub-issues are never published.

When a ticket that already has a parent (for example an audit ticket) moves
under a capability, the old parent is kept as a "related" link, so its origin
isn't lost.

### Title rules

The title is published exactly as written, so it has to stand on its own in
public:

1. It is written for an examiner and describes an outcome, not an
   implementation ("Report states what was not examined", not "Add
   coverage query").
2. It contains no ticket identifiers (`EPOCH-`, `VER-`), no square brackets,
   no people's names, and no case, device or customer data.
3. It names no unfixed security weakness. A weakness is described once it is
   fixed, or in general terms ("Hardened secrets handling").
4. It makes no promise of a date or a version.
5. It may name third-party tools the product uses (iLEAPP, PostgreSQL),
   but never implies their authors endorse the project.
6. It is in sentence case, at most 90 characters, with no trailing full stop.

The publisher checks rules 2 and 6 mechanically and refuses an issue that
fails them. The others are checked by the person applying the label.

## Lanes

The lanes follow the workflow vocabulary (acquire, process, extract, analyze,
report), plus two lanes for trust and examiner input.

| Lane label | Covers |
|---|---|
| Acquire | Getting evidence off a device |
| Process | Identifying, decrypting, verifying and scanning evidence |
| Extract | Turning processed evidence into traceable facts |
| Analyze | Finding patterns across facts, including AI-assisted leads |
| Report | The report and the desktop app the examiner works in |
| Trust | The air gap, verifiable releases, custody and secrets |
| Examiner input | Where practising examiners shape the product (EPOCH-440) |

## Status

A capability's public status comes from its Linear status, which is **set by
hand** by an arbiter. Public status is a statement to examiners, so it is
never computed from ticket counts.

| Linear status | Public status | Shown under |
|---|---|---|
| Backlog | Exploring | Later |
| Todo | Planned | Next |
| In Progress | In progress | Now |
| Done | Shipped | Shipped |
| Canceled | Removed; the change log records it as "Withdrawn" | — |

- **Shipped** means the capability works end to end on `dev` and the
  definition in its description has been verified. Until releases exist, the
  page says that Shipped means available in the development build.
- In Review and Duplicate aren't used for capability issues.
- Linear's sub-issue automations (closing a parent when its sub-issues close)
  must stay off for this team. If one ever changes a capability's status, an
  arbiter reviews the change.

## Who applies the label

The arbiters are the project owner and Claude, acting as co-arbiter of Linear.
Applying **Public** approves the title for publication. Before applying it,
the arbiter checks the title rules, the lane, the status, and that the
description defines Shipped. Removing the label withdraws the capability from
the page at the next publish.

## What is published

For each Public capability, and nothing else:

| Field | Source |
|---|---|
| `key` | The Linear identifier (for example `VER-150`), used only as a stable key |
| `title` | The issue title, verbatim |
| `lane` | The Lane label's name |
| `status` | The public status, mapped as above |

Each change to one of those fields adds a change-log entry: the UTC date, the
`key`, the field, and the old and new public values. The snapshot also carries
the time it was generated and its schema version.

Never published: descriptions, comments, sub-issues, people, priorities,
estimates, milestones, cycles, target dates, other labels, attachments, and
links into Linear.

## How it is published

1. **Projection** (EPOCH-480). Shared code reads only Public issues, applies
   the mechanical title checks, and emits the fields above. The static page is
   built from its snapshot.
2. **Webhook** (EPOCH-481). A serverless function receives Linear's issue
   events. It verifies the signature, ignores repeated deliveries, runs the
   same projection, and writes the snapshot and change log. A nightly full
   reconcile rebuilds the snapshot from Linear, to catch missed deliveries.
3. **Secrets and logs.** The signing secret and a read-only Linear API key live
   only in the function provider's secret store. Raw Linear payloads are never
   stored or logged: logs record delivery IDs and outcomes only. Any job that
   runs in this repository's CI writes only projected output, because the CI
   logs are public.

## What the page says

- Status words and Now / Next / Later. No percentages, and no target dates
  until a date is a real commitment.
- Any count or snapshot figure carries the date it was taken.
- Claims describe what is built. A planned property, such as the Lab build's
  network blocking (EPOCH-438), is shown as a goal with its status, never as
  something the product already does.
- Known rule violations are linked from [rules.md](rules.md), matching the
  repository's candour.
- The Examiner input lane lists the open questions examiners can answer.
- Milestone checklists are written in the page's own source, reviewed like any
  other change, and never read from Linear.
