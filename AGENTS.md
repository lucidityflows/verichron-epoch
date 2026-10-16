# AGENTS.md

How AI coding agents (Claude, Gemini and others) work in this repository.
`CLAUDE.md` and `GEMINI.md` only point here.

## 1. Sources of truth

- **The repository's docs are canonical.** Read [README.md](README.md), then the
  `docs/` page for the area you're changing: [architecture](docs/architecture.md),
  [evidence model](docs/evidence-model.md), [rules](docs/rules.md),
  [decisions](docs/decisions.md), [development](docs/development.md).
- **Scope comes from the Linear ticket** (`EPOCH-<n>`).
- **Every change respects [docs/rules.md](docs/rules.md).** Cite rules as `R<n>`.
- **A change that settles a decision updates [docs/decisions.md](docs/decisions.md)
  in the same PR.** A change to how the system works updates the doc that
  describes it. Docs explain each thing once; link rather than repeat.
- **UI work follows [apps/epoch/DESIGN.md](apps/epoch/DESIGN.md).** Deviations
  are documented and approved by the user first. The design system is a living
  document and open to discussion.

## 2. Project conventions

- **Development data is disposable.** Fail fast, with no fallbacks, backfills or
  legacy-compatibility paths.
- **Never disable a pipeline stage** (`enabled: false`) to make a build look
  stable, unless the user has explicitly agreed. Fix it, ticket it, or raise it.
- **Verify claims against the code before acting on them,** including claims in
  tickets, reviews and earlier conversation. Re-check rather than cite a past fix.
- **Keep the polyglot split:**
  - TypeScript runs the control plane (`apps/epoch`, `apps/processor`,
    `apps/orchestrator`);
  - Python parses, writes facts (`db_writer.py`, the only writer) and renders the
    report.
- **Workspaces:** respect `pnpm` (e.g. `pnpm --filter <pkg>`) and `uv`
  (`uv run`, `uv sync`) conventions. Tool versions are pinned once, in
  `mise.toml`, `.python-version` and `package.json`; set up with
  `mise run setup` ([development](docs/development.md)). The backup decrypt and
  iLEAPP run from their own environments under `tools/`, never from the
  workspace venv.
- **Product:** the first target is an air-gapped **Lab build**, a separate build
  rather than a runtime mode. A Personal build follows. The LLM produces *leads*,
  never evidence.

## 3. Error handling

- **Errors are data points.** Treat mistakes, regressions and misinterpretations
  as objective data.
- **Zero alarm.** No alarm, defensiveness or excessive apologies.
- **Analytical rectification over overcompensation.** Don't rush a correction.
  Find the root cause from evidence, outline the fix, and wait for the user's
  approval before acting.

## 4. Context management

- **Absolute overrides.** When a file or version is designated as the source of
  truth, treat it as a hard overwrite and ignore earlier iterations.
- **Strict boundaries.** Don't stitch, merge or carry over historical data,
  rules or ledgers into a new baseline unless told to preserve them.
- **Negative constraints.** Follow negative instructions (e.g. "do not merge
  with previous versions") strictly.
- **Hard resets.** A new session is the reliable way to clear a saturated
  context.

## 5. Editing safely

- **Targeted block patching.** Change only explicitly bounded blocks rather than
  rewriting whole files, so nothing is lost in regeneration.
- **Verbatim preservation.** Ledgers, tracking tables and migration logs are
  append-only. Preserve existing entries exactly.
- **Check the diff before writing.** Review it to confirm historical lines and
  records are intact.

## 6. Working with the user

- The user is a software architect and engineer, and the final arbiter of major
  decisions.
- The agent is a collaborative partner: research, summaries, notes and
  implementation, so the user can focus on the wider project.
- Perfection isn't expected; best practice is. When something is ambiguous,
  pause, lay out the options, and decide together.
