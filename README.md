# Verichron Epoch

Verichron Epoch is a forensic workbench for iOS devices. It takes an encrypted
iTunes/Finder backup, decrypts and verifies it, runs extractors and indicator
(IOC) matching over it, and produces a report an examiner can defend: every fact
is traceable to the exact evidence, tool version and IOC set that produced it.

It behaves like a careful lab technician, not a scanner: it never loses,
misattributes or over-claims evidence, and it always says what it did not do.

> **Status:** pre-release. The first target is an air-gapped **Lab build**
> ([decision](docs/decisions.md#product-and-builds)). Open work is tracked in
> Linear (project prefix `EPOCH-`).

## How it fits together

```
device / backup ──► processor ──► orchestrator ──► stages ──► PostgreSQL ──► report, desktop app
                    hash, decrypt,   register evidence,  extract,
                    repair, IOC scan run stages in order  write facts
```

Read [docs/architecture.md](docs/architecture.md) for the full picture.

## Documentation

| Read this | To learn |
|---|---|
| [docs/architecture.md](docs/architecture.md) | The components, how data flows, and where each piece lives |
| [docs/evidence-model.md](docs/evidence-model.md) | How evidence, derivatives, runs and facts are identified and related |
| [docs/rules.md](docs/rules.md) | The architecture rules (R1–R35) every change must respect |
| [docs/decisions.md](docs/decisions.md) | Settled decisions and why they were made |
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
