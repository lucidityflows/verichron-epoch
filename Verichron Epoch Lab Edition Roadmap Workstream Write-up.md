# Verichron Epoch Lab Edition: Roadmap Workstream Write-up

Prepared 2026-10-11 · Working draft for review · No Linear tickets or repo docs were changed

## 1. Purpose and ground rules

The goal is a roadmap for Lab Edition 1.0. It will be public facing: part of initial outreach to forensic examiners, whose feedback we want, and an announcement of goals for parties interested in the alpha.

- **Sources of truth.** Linear is the roadmap source of truth for this task. The repository docs (dev branch) win any contradiction about the project. The Oct 7 roadmap (Architecture Guide PDF) is out of date and is a starting point and reference only.
- **Authorization.** Claude has read access to Linear and the repo and is not authorized to change tickets or repo docs at this time. Anything below that would need such a change is a proposal.

## 2. Work completed

1. Located the Linear project Verichron Epoch: Lab Edition 1.0 (P-VER-2) and pulled its milestones, tickets, statuses, labels and resources.
2. Published a proof-of-concept page for one stream (iLEAPP) as a private artifact: https://claude.ai/artifact/9e9hLxDoFoAL7mvL27TCTr. Its streams came from the Oct 7 roadmap, so treat it as a prototype of the rendering approach only. The design has since been reset (section 5).
3. Checked label state in Linear (section 3.1).
4. Critiqued the POC against what roadmaps are meant to deliver, then reset the design for a public audience.
5. Read the repository documentation: README, AGENTS, architecture, rules, evidence model, decisions and development guide, plus the headings of the extractor contract and the design doc.
6. Worked through delivery architecture for an air-gapped alpha: bundling, PostgreSQL, the AI module, platform and network confinement.

## 3. Findings

### 3.1 Linear

- 64 tickets in the project at the time of the pull (61 active, 3 closed) across three milestones: End-to-End Processing Baseline, Evidence Handling Readiness and Lab Edition Release Candidate. Milestones carry written exit criteria that name their gating tickets.
- Streams do not exist in Linear. The labels in use are tech labels (Python, TypeScript, UI and so on). A Product area group (Lab, Consumer, Shared) exists, but no ticket in the project carries it. Two active tickets had no labels at all (VER-16 and VER-122).
- Milestone 1 against its four written exit criteria: none was met, and 2 of 9 gating tickets were done at the pull. Linear's own 35% figure overstates how close the milestone is, because it counts all tickets, not gates.
- Status moves quickly. For example, VER-133 changed from Done to in progress between two pulls. A static snapshot goes stale fast, which is the case for live updating.
- The Roadmap link on the project points to a claude.ai artifact that could not be opened with the access available.

### 3.2 Repository

- The repository is public and the Linear workspace is private. A decision record states that ticket content must not reach public places. EPOCH numbers are already public in the docs.
- The workflow vocabulary is settled: acquire, process, extract, analyze, report. The first release is the air-gapped Lab Edition; Personal Edition follows from the same core.
- Trust claims are part of the product: no network in Lab with no setting to re-enable it, IOC sets and tools imported from media and hashed, one pinned toolchain, every fact traceable to evidence, tool version and IOC set, and AI output kept separate as leads that the examiner confirms or dismisses.
- rules.md publishes known violations (R28, R29, R30) with ticket numbers and states they are ticketed and fixed, never waived. The project's posture is transparency.
- rules.md also lists what is deliberately not done (no cross-device deduplication, no guessed timestamps, no secrets in defaults). This works almost verbatim as a public non-goals section.
- Gaps the docs do not answer: how an examiner installs and runs the product, supported platforms and iOS versions, and the desktop app's absence from CI (EPOCH-454).

### 3.3 Critique of the first approach

- Progress was an unweighted ticket count. Gate-based progress with proof is closer to real progress.
- There was no time axis, so the page could not show on track or at risk.
- Stream membership was a static mapping, so an unmapped ticket silently disappeared, and absence reads as completion.
- Order and dependencies were asserted from the old roadmap, not sourced from Linear.
- It could not show scope change or what changed since last time.
- Done meant a closed ticket, not verified or merged.

## 4. Decisions

### Confirmed by you

| Decision | Notes |
| --- | --- |
| The roadmap is public facing, for examiners and alpha-interested parties | Fresh design; the old roadmap is reference only |
| All documented features are in the alpha | Ollama was the only possible exception |
| Ollama ships as an optional supplemental build module | Separate from the core bundle |
| The air-gapped build is a bundle | Easiest route for air-gapped delivery |
| PostgreSQL is bundled and app-managed | Approved |
| Debian builds first | macOS dropped for simplicity |
| The inference spike compares both options | Ollama confined behind a unix-socket bridge, and llama.cpp llama-server on a unix socket |

### Recommended by Claude, not yet confirmed

- amd64 only for the alpha, with an AVX2 minimum and arm64 as a later addition.
- Debian 13 as the support target, built in a container pinned by digest, with the build floor equal to the support floor. An earlier lean toward building on an older glibc was walked back; that question is unanswered.
- A tarball with a signed manifest, run without root. Admin rights are needed only for udev rules and the USB device service.
- A core that uses unix sockets only, enforced at the OS level, with the AI module confined in a private network namespace behind a unix-socket bridge.
- Gating the alpha on the core only, so the module can ship later in the alpha cycle if it slips.
- An upgrade path of a new bundle, with the database rebuilt from the original backups (it is a derived store).

## 5. Public roadmap design (proposed)

- **Unit:** a capability, written in examiner language (about 8 to 12), with tickets feeding progress behind the scenes. Raw tickets are never the public unit.
- **Lanes:** acquire, process, extract, analyze, report, plus a trust lane and an examiner-input lane, following the repo's vocabulary.
- **Modeling in Linear:** one parent issue per capability with a Public label, or a mapping file as the alternative. Either way the publisher is default-deny: only opted-in items and allowlisted fields leave Linear.
- **Presentation:** status words (Shipped, In progress, Planned, Exploring), Now / Next / Later, and no percentages or dates until a date is a real commitment.
- **Milestone 1:** shown as a gated checklist with a stated proof for each criterion, with Linear's percentage demoted.
- **Disclosure:** match the repo's candor. Describe work plainly and link to the rules.
- **Open questions:** show where examiner input shapes the product, such as network enforcement, signing and audit artifacts (EPOCH-440).

### Draft capability list (statuses as of the 2026-10-11 snapshot)

| Lane | Capability | Status |
| --- | --- | --- |
| Acquire | Pull an encrypted backup from a connected iPhone | In progress |
| Process | Evidence identified by content hash | Built |
| Process | Decrypt with SQLite repair and recorded outcome | Built |
| Process | IOC scan against a hashed copy of the IOC set | Built |
| Process / Extract | iLEAPP output ingested atomically as its own derivative | In progress |
| Extract | Facts from crash logs, iLEAPP and IOC detections, timestamps never guessed | Partly built |
| Report | Report that states what was not examined | In progress |
| Report | Desktop app for runs, records, IOCs and reports | In progress |
| Trust | Air-gapped, self-contained Lab bundle | Planned |
| Trust | Verifiable releases: signed manifest, published hashes, SBOM | Planned |
| Trust | Immutable custody records and an audited purge procedure | Planned |
| Trust | Hardened secrets and credential handling | Planned |
| Analyze | AI-assisted leads as an optional module | Planned |
| Input | Lab requirements defined with examiners | Open |

## 6. Architecture notes (proposed)

- **Core bundle:** the desktop app, the Python runtime, mvt, iLEAPP, sqlite3, the device-backup tools and an app-managed PostgreSQL 16 built from source and reached over a unix socket. One signed manifest covers everything. The manifest hash is recorded with every run (R35).
- **AI module:** Ollama, pinned model weights and a Modelfile, signed separately and imported from media. Its manifest names compatible core versions. Without it, the analysis stage is recorded as skipped (module not installed) and the report says AI-assisted analysis was not run. This follows R21 and the rule that not analysed never reads as nothing found.
- **Network:** the core allows only unix sockets. Ollama is a TCP server, so it needs OS-level confinement because code-level guards cannot police a third-party binary. Plain loopback with OS confinement is the documented fallback.
- **Build:** a pinned Debian container, with an arch field in the manifest. Release verification is out of band: published hashes and an SBOM, checked before the bundle crosses the air gap.
- **Licensing:** audit redistribution terms for mvt (a custom license), the LGPL and GPL device components, and the chosen model. Prefer a permissively licensed model for the baseline.
- **Hardware:** a CPU baseline, with GPU as an optional later artifact. Model outputs are not bit-reproducible across hardware, so record digest, versions, prompt version, parameters and hardware class on each lead.

## 7. Webhook (phase 2)

Linear sends Issue events for create, update and remove. The receiver verifies the signature, dedupes on delivery ID, projects only allowlisted fields, appends each change to an immutable event log and writes a static snapshot. A periodic full reconcile catches dropped deliveries. The event log supplies the public what-changed feed and a scope burn-up. A page published as a claude.ai artifact cannot fetch live data from another site, so live updating needs a self-hosted page that reads a snapshot file. The data block in the POC was designed for that swap.

## 8. Inference spike (proposed)

Timebox: two to three days. Questions: isolation with no route out, reachability with internet-family sockets denied, namespace availability on Debian 13, model digest stability, determinism, footprint, lifecycle behavior, and integration cost. Decision rule: choose the confined Ollama sidecar if isolation, reachability and namespaces pass on Debian; choose llama-server if its native unix socket is confirmed and determinism and integration cost are at least as good; keep loopback as a documented exception only. Scope also covers module packaging and the module-absent path.

Approvals needed before any install: the pinned Ollama Linux tarball, the llama.cpp source and a local build, one permissively licensed candidate model, and strace if absent.

## 9. Risks and open decisions

- Platform reach: a Debian x86-64 alpha skews the feedback pool toward Linux users. Ask examiners what they examine on.
- Signing authority and key custody depend on EPOCH-440, which is still open.
- Baseline model and minimum hardware come out of the spike.
- Whether the alpha gates on the module. The recommendation is the core only.
- Capacity: bundled Postgres, confinement, signed builds and the app are a lot of infrastructure, and should be sequenced.

## 10. Next steps

Items marked with an asterisk need authorization to change tickets or repo docs.

1. Confirm or correct the unconfirmed recommendations in section 4.
2. Decide how streams and public capabilities are modeled: a Public label on parent issues, or a mapping file.\*
3. Apply the chosen tags and create the proposed tickets: spike, bundled Postgres lifecycle, Debian release-build pipeline with manifest signing, module packaging, and the module-skipped path in runs and reports. Split VER-13 into the core toolchain bundle and the AI module.\*
4. Amend decisions.md so leads run in Lab when the AI module is installed.\*
5. Run the spike once the installs are approved.
6. Build public roadmap v1 from the capability list.
7. Build the webhook receiver.

## Appendix: references

- POC page: https://claude.ai/artifact/9e9hLxDoFoAL7mvL27TCTr
- Repo docs read (dev branch): README.md, AGENTS.md, docs/architecture.md, docs/rules.md, docs/evidence-model.md, docs/decisions.md, docs/development.md
- Tickets referenced: VER-13 (EPOCH-439), VER-15 (EPOCH-438), VER-122 (EPOCH-440), VER-133 (EPOCH-465), VER-16 (EPOCH-309)
