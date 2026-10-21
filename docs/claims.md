# Claims register

Every statement Verichron Epoch makes about itself in public (the README, these
docs, the public roadmap and site, agreements, release notes, the app's About
view) is listed here, with the evidence for it and a status. Examiners may rely
on what we say, and may quote it back, so a claim is made only when it can be
shown.

| Status | Meaning |
|---|---|
| **Supported** | The evidence exists and is linked. The claim may be made, in the wording given |
| **Pending** | True by design, but not yet shown. It may be described as a goal or a plan, never as a fact |
| **Not to be made** | Never stated, whatever the evidence |

**The rule:** a new public claim gets an entry here before it is published, and
a claim that loses its evidence moves back to pending. Measured numbers are
quoted with their date and source. Each claim is scoped to the edition it is
true of. Self-assessed, not attorney reviewed (2026-10-17, EPOCH-536).

## Claims

| Claim | Where it is made | Evidence | Status |
|---|---|---|---|
| The Lab Edition makes no network connections | README, `docs/architecture.md`, `AGENTS.md` (as the first target) | EPOCH-438's zero-connection test, not yet written. The Lab build has no network exception; internal indicator servers are reached through a separate bridge (EPOCH-568) | Pending. Say "the first target is an air-gapped Lab build", not "Epoch is air-gapped" |
| Epoch makes no third-party network requests | Not yet made | The app requests its fonts from Google's servers today; self-hosting them (EPOCH-564) removes the request, and its test fails on any external URL | Pending, until EPOCH-564 ships |
| No telemetry: nothing about the user, the evidence or the use of the app is sent anywhere | Not yet made | A code search on 2026-10-17 found no code that sends telemetry; every match was the parsing of the device's own diagnostic files. Nothing tests for it yet; the Lab Edition's zero-connection test (EPOCH-438) would show it for that edition | Pending |
| Every fact is traceable to the evidence and the tool versions that produced it | README | R7, R16 and R35; per-run tool versions and derivative provenance (EPOCH-406) | Supported, as a statement of what is recorded |
| Times are never guessed: a time is UTC and timezone-aware, or empty, and the report counts records with no time | `docs/evidence-model.md`, `docs/rules.md`, the extractor contract | R11; EPOCH-419 (declared epochs and a plausibility window) | Supported |
| Indicator checks run against the project's own matching on extracted facts, using a recorded, hashed indicator set, and state the set, its age and what was not checked | README (updated 2026-10-17) | EPOCH-490, 491, 493 | Supported |
| On the 19 public indicator files of 2026-10-15, 11,124 of 11,625 indicators load; 501 are counted by reason | `docs/decisions.md` (EPOCH-490) | EPOCH-490's loader run of 2026-10-15 | Supported, with that date. Re-measure before quoting for a newer set |
| Epoch is designed to tie every fact to the evidence it came from, to claim no more than that evidence shows, and to state what it did not examine | README (reworded 2026-10-17; the earlier "it never loses, misattributes or over-claims evidence" is withdrawn) | Provenance: R7, R16 and R35. Coverage: the report states what was and was not examined (EPOCH-448) | Supported, as a statement of design. An absolute "never" or "always" is not to be made |
| AI output is presented as leads for the examiner to confirm or dismiss, separate from the facts | `docs/decisions.md`, `AGENTS.md` | EPOCH-442 | Pending, until EPOCH-442 ships |
| Third-party tools are disclosed: which tool, which version, how Epoch uses it, and each flaw Epoch corrects | `docs/decisions.md` | EPOCH-524 (generated record), EPOCH-473 (licensing audit), R36 (tool-defect registry) | Pending, until EPOCH-524's record is generated |
| Epoch adds measurable value over the tools it uses alone | Not yet made | EPOCH-525 (head-to-head) | Pending. Only measured advantages may be claimed |
| Epoch is designed to process evidence on the machine where it runs | Privacy statement (draft, EPOCH-537), About view | `docs/architecture.md` (a local pipeline); bundled PostgreSQL is not built yet (EPOCH-477); the zero-connection test (EPOCH-438) | Pending. Design wording only |
| The Epoch website is a static site with no server-side processing of visitor data | Privacy statement (draft) | The site build (EPOCH-528) | Pending, until the site is built |
| The Epoch website sets no cookies, runs no analytics or advertising, and loads nothing from other sites | Privacy statement (draft) | A recorded check of every page (EPOCH-537) | Pending, until the check passes |
| The web host keeps server logs of visitor IP address, time and page for a stated period | Privacy statement (draft) | The host's settings | Pending, until a host is chosen |
| Interest-list details are kept, used, shared and deleted as the statement describes | Privacy statement (draft) | The list as set up, and its access controls | Pending, until the list is set up |
| Case data sent to us by mistake is deleted without review, and the deletion is confirmed | Privacy statement (draft), alpha agreement (A4, Schedule 2) | A written deletion procedure | Pending, until the procedure is written |

## Not to be made

- That a result means a device is "clean", "safe" or "not compromised". No indicator match, no YARA match (EPOCH-566) and no AI lead is proof of absence (`docs/rules.md`, Deliberately not done).
- Verdict wording for indicator results ("infected", "compromised"); results say what matched, against which set.
- That Epoch's output is accepted by courts, certified, validated or forensically sound, without an external record that names it.
- That AI output is evidence or a finding. It is a lead.
- That Epoch uses or depends on tools it no longer uses (for example mvt).
- That Epoch "uses no third-party software". It ships third-party components, each disclosed in the notices; the claim that can be made is about network requests, above.
- Any number without its date and source.
- That no other tool does something, or that Epoch is the first or only tool to do it. A search finds what is published, not what exists: commercial vendors may hold internally what they don't publish. At most, "we found no published …", with the date and the sources searched (for example the reference document of 2026-10-21 on field-level coverage, EPOCH-583).
