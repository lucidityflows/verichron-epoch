# Verichron Epoch

Verichron Epoch is a forensic workbench for iOS devices. It takes an encrypted
iTunes/Finder backup, decrypts and verifies it, runs extractors over it, and
produces a report an examiner can defend: every fact is traceable to the exact
evidence and tool versions that produced it. Indicator (IOC) checks use the
project's own matching on extracted facts, against a recorded, hashed indicator
set, and state the set, its age and what was not checked (EPOCH-490 to 493).

It is designed to work like a careful lab technician, not a scanner: to tie
every fact to the evidence it came from, to claim no more than that evidence
shows, and to state what it did not examine.

> **Status:** pre-release. The first target is an air-gapped **Lab build**
> ([decision](docs/decisions.md#product-and-builds)). Open work is tracked in
> Linear (project prefix `EPOCH-`).

> **Licence:** Verichron Epoch is proprietary software of Verichron Inc. The
> source is public so it can be read; this is not an open-source release, and
> no licence is granted ([LICENSE](LICENSE)). Outside contributions are not
> accepted ([CONTRIBUTING.md](CONTRIBUTING.md)). Third-party components keep
> their own licences.

## How it fits together

```
device / backup ──► processor ──► orchestrator ──► stages ──► PostgreSQL ──► report, desktop app
                    hash, decrypt,   register evidence,  extract,
                    repair, iLEAPP   run stages in order  write facts
```

Read [docs/architecture.md](docs/architecture.md) for the full picture.

## Documentation

| Read this | To learn |
|---|---|
| [docs/architecture.md](docs/architecture.md) | The components, how data flows, and where each piece lives |
| [docs/evidence-model.md](docs/evidence-model.md) | How evidence, derivatives, runs and facts are identified and related |
| [docs/indicator-field-map.md](docs/indicator-field-map.md) | Which facts can supply which indicator types, and which types no backup supplies |
| [docs/rules.md](docs/rules.md) | The architecture rules (R1–R36) every change must respect |
| [docs/decisions.md](docs/decisions.md) | Settled decisions and why they were made |
| [docs/claims.md](docs/claims.md) | Every public claim, its evidence and whether it may be made |
| [docs/development.md](docs/development.md) | Setting up, running the pipeline, testing, CI |
| [docs/roadmap.md](docs/roadmap.md) | How the public roadmap is published from Linear, and what may appear on it |
| [packages/contracts/EXTRACTOR_CONTRACT.md](packages/contracts/EXTRACTOR_CONTRACT.md) | What every pipeline stage must do |
| [apps/epoch/DESIGN.md](apps/epoch/DESIGN.md) | The desktop app's visual design system |
| [AGENTS.md](AGENTS.md) | How AI coding agents work in this repo |
| [Roadmap](https://claude.ai/code/artifact/44e87cfa-27da-47cd-87ae-d6ef351b9ff6) (external) | The earlier visual view of progress, being replaced by the public roadmap (EPOCH-480). The docs here win any disagreement |

Each package has a short README covering only what is specific to it.

## Repository map

| Path | What it is | Language |
|---|---|---|
| `apps/epoch` | Electron desktop app | TypeScript |
| `apps/processor` | Prepares evidence: hashes and verifies backups, then produces derivatives (decrypt, repair, iLEAPP) | TypeScript |
| `apps/orchestrator` | Registers evidence and runs the pipeline stages | TypeScript |
| `apps/extractors/*` | Stages that turn tool output into facts (`crash`, `ileapp_bridge`) | Python |
| `apps/analysis` | LLM stage that proposes leads; out of the pipeline until EPOCH-442 | Python |
| `apps/reporting` | Generates the investigation report | Python |
| `packages/contracts` | Shared schemas and types (TS and Python) | both |
| `packages/etl-db-writer` | The fact writer, migrations and `migrate.py` | Python |
| `packages/etl-db-reader` | Read-only queries for the app | TypeScript |
| `libs/*` | Python helpers: run tallies, runtime checks, test doubles | Python |
| `scripts/` | Developer tools, generators and Python test suites | Python |
| `infra/` | Local PostgreSQL via Docker Compose | — |
