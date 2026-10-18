# Verichron Epoch — Design Tokens & Visual Hierarchy

Source of truth for EPOCH-201 (VER-8) and every ticket downstream of it
(EPOCH-202/203/204/301). Nothing in those tickets should introduce a
pattern that contradicts this file. All tokens live in
`apps/epoch/src/renderer/index.css`.

## 1. Elevation, not borders

`shadow-elevation-{1,2,3}` is the only way a **panel-level container**
(card, page section, modal) expresses separation from the background.
Flat `border`/`border-*` utilities are reserved for two cases only:

- **Functional borders** — form inputs, textareas, anything with a focus
  ring. A shadow doesn't communicate "this is editable" the way a border
  does.
- **Structural dividers** — table row/column separators, `border-b`
  under a header, dashed drop-zone affordances. These separate content
  *within* a container, not the container from its background.

If you're adding `border` to something that reads as its own card/panel,
it's the wrong tool — use elevation.

| Tier | Use for |
|---|---|
| `shadow-elevation-1` | Resting state — page-level cards, static panels |
| `shadow-elevation-2` | Interactive/hover state, or a panel one level "up" from its siblings (e.g. a modal's card while the page behind it sits at tier 1) |
| `shadow-elevation-3` | Modals, overlays — anything floating above the whole page |

Do not mix `border` + `shadow-elevation-*` on the same container to
signal the same thing (accent-color left-borders like `RunsView`'s
status indicator are a different signal — state color, not elevation —
and can coexist with a shadow tier).

**Table rows:** a selected row has the accent bar (an inset accent shadow),
an expanded row has `shadow-elevation-1`, and a row that is both has both
(EPOCH-470). Selection is never hidden by expansion.

**State-color banners (flag/danger/accent) are always `shadow-elevation-1`
+ the state-color border together, never border alone.** This was
previously inconsistent — e.g. `DevicePullPanel.tsx` had two flag-toned
banners in the same file, one with `shadow-elevation-1` and one without,
for no reason other than having been written at different times. Fixed
in that file (see §5); the rule going forward is that every state-color
banner gets both, uniformly.

**Error banners carry a Copy button** (`components/ui/CopyButton`). It
copies the error with what's needed to diagnose it elsewhere: the step,
the device, and the log or tool output that led to it. It never copies
secrets such as passwords. In place: the iPhone pull error and the setup
failure banner (EPOCH-466); other views' error banners follow in the
EPOCH-464 review.

**Toasts** (`components/ui/Toast`, EPOCH-455; approved 2026-10-14) are for
confirmations and errors that don't belong to a place on the page, such as
the result of an action whose panel has closed. They float at the bottom
right at `shadow-elevation-3` on `surface-raised`, with the role's `/30` border
(§9): `success` for done, `danger` for failed, and the plain border for
information. A success or information toast closes itself after five seconds;
a failure stays until it is dismissed, so it can't be missed. Screen readers
hear successes politely (`role="status"`) and failures at once
(`role="alert"`). A toast never replaces an error banner that belongs to a
view, and never carries a secret.

## 2. Type scale — four tiers, by role not by size

Each tier is a **composite** Tailwind v4 utility (`text-display`,
`text-heading`, `text-label`, `text-data`) that carries font-size, line-height, and
font-weight together — never hand-combine `text-base` + `font-medium`
to approximate one of these; use the named class.

| Class | Size / weight | Use for |
|---|---|---|
| `text-display` | 1.25rem / 600 | The one heading per view/route — page titles. Every top-level section header in the sidebar-navigated views (`WorkspaceView`, `RunsView`, `IocsView`, `ReportsView`, `RecordsView`) is a page title in this sense, even though some render inside a shared shell — there is exactly one per view. |
| `text-heading` | 1rem / 600 | Section and card titles (`h2`/`h3`) inside a view: the option cards on New Investigation, "Backups Found", a dialog's title. Added 2026-10-09 (EPOCH-464); see the amendment below the table. |
| `text-label` | 0.75rem / 500 | UI chrome: form labels, tab/filter labels, panel sub-headings (e.g. a card's own `<h3>` inside a page that already has its `text-display` title), uppercase eyebrow text, **and button text** (see EPOCH-203 / `Button.tsx` — a button's label is UI chrome, not content). |
| `text-data` | 0.8125rem / 400 | Actual content — table cells, timestamps, IDs, badge-adjacent values, log lines. This is the default for anything that isn't a heading or a form label. |

`text-2xs` (0.65rem, defined separately in `@theme`) stays as-is for
`Badge.tsx`'s compact mono badges — it is a deliberate exception for a
single dense component, not a 4th tier of the scale above. Don't reach
for it elsewhere; use `text-label` or `text-data` instead.

We are explicitly **not** adding a 4th tier right now. If a real gap
shows up during 202/203/204/301, raise it as its own ticket rather than
inventing an ad hoc size in place.

*Amended 2026-10-09 (EPOCH-464):* the gap showed up. With only
`text-display` (20px) and `text-label` (12px), a card title had no correct
size, so New Investigation improvised three (16px semibold, 12px label, 14px
semibold) and titles ended up smaller than their own descriptions.
`text-heading` (1rem / 600) is the fourth tier, for section and card titles
only. Content stays `text-data`; labels stay `text-label`. In order of size:
`text-display` > `text-heading` > `text-data` > `text-label`.

*Fixed 2026-10-12 (EPOCH-484):* `cn()` merges classes with tailwind-merge,
which didn't know these names. It read them as text colours and dropped
`text-label` from `text-label text-background`, so every `Button` rendered at
the inherited 16px and outranked the card titles above it. `libs/utils.ts`
now registers the scale as font sizes. A new type-scale class is added there
too.

## 3. Spacing scale — 4px grid, with one named exception

Unlike elevation and type scale, Tailwind's default spacing utilities
are **not a closed set we redefine in `index.css`** — `px-2.5` (10px)
and `px-3` (12px) are equally valid Tailwind utilities with nothing in
the CSS itself marking one as wrong. The rule below is a team
convention layered on top of an open scale, not a token boundary, which
is exactly why it has to be written down here rather than inferred from
a diff: there is nothing to check it against otherwise.

**Default rule:** padding and margin utilities (`p-*`, `px-*`, `py-*`,
`pt-*`/`pr-*`/`pb-*`/`pl-*`, and the `m-*` family) use only values on
the 4px grid — `1` (4px), `2` (8px), `3` (12px), `4` (16px), `5` (20px),
`6` (24px), and so on. Half-steps (`1.5`/6px, `2.5`/10px, `3.5`/14px)
are **not** used for padding or margin. This applies to card padding,
button padding, and vertical rhythm between stacked elements alike.

**Named exception — icon-to-label gap:** `gap-1.5` (6px) is the
sanctioned spacing between a leading icon and its adjacent text label
*within a single inline control* (a button's icon + text, a status
row's icon + message). This is the same shape of carve-out as
`text-2xs` in §2 above — a named, bounded exception, not a loophole.
Icon glyphs and text don't share the same optical bounding box the way
two lines of text do, so a whole-grid `gap-2` (8px) can visibly
under-hug an icon against its label in a way `gap-2` between two text
elements never does. The exception is narrow:

- Applies to: icon + label pairs inside one control (a button, a status
  line, a badge-adjacent icon).
- Does **not** apply to: spacing between distinct controls, card
  sections, list items, or anything else that isn't a single
  icon-to-text pairing. Those stay on-grid.
- `gap-1.5` is the one sanctioned half-step value for this case — don't
  introduce other half-steps (`gap-2.5`, `gap-3.5`) under this
  exception's umbrella.

**Why not encode this in `index.css` instead:** restricting Tailwind's
generated spacing scale at the token level (so `px-2.5` simply doesn't
exist) is a legitimate future option, but it's a repo-wide decision
affecting every spacing utility in the app, not just the components
this pass touches, and it forecloses the icon-gap exception above
without an arbitrary-value escape hatch. Not doing that here; this
section is the enforcement mechanism for now, the same way §1 and §2
are enforced by code review against a written rule rather than by a
lint rule.

## 4. Token structure — dark-only today, light/dark-ready by design

A light theme is a confirmed future requirement (not speculative), so
tokens are structured now to make that a same-file addition later
rather than a second migration:

```css
:root {
  /* current dark values — this is the DEFAULT, not a "dark" override */
  --background: 217 17% 9%;
  --surface: 217 17% 14%;
  /* ...existing tokens, unchanged... */
}

/* Placeholder for the future toggle. Adding a light theme later means
   filling in this block — no restructuring of :root, no renaming of
   any token, no changes to any component. */
:root[data-theme="light"] {
  /* intentionally empty until EPOCH-XXX (light theme) */
}
```

Components must keep referencing the semantic token names
(`bg-background`, `text-foreground`, etc.) exactly as they do today —
never a raw HSL value or a hardcoded dark-specific assumption. That's
what makes the future toggle a CSS-only change.

## 5. Per-component migration status (this pass)

| Component | Elevation fix | Type-scale fix | Spacing fix |
|---|---|---|---|
| `RunsView.tsx` | Yes — stage cards mixed `border` + Tailwind default `shadow-md`, neither of which is our token | Yes — header | Not yet audited against §3 |
| `IocsView.tsx` | Yes — indicator cards used flat `border-border`/`border-flag` | Yes — header | Not yet audited against §3 |
| `ReportsView.tsx` | Yes — every panel (error, empty states, report container) used flat `border-border` | Yes — header | Not yet audited against §3 |
| `RecordsView.tsx` | No change needed | Yes — header | Not yet audited against §3 |
| `WorkspaceView.tsx` | No change needed (already elevation-only; dashed drop-zone border is a legitimate functional exception) | No change needed (`<h1>` already correct) | Not yet audited against §3 — known half-steps remain (e.g. modal `px-3.5`/`py-2.5`, several `gap-3.5`/`gap-2.5` outside the icon-label exception) |
| `DevicePullPanel.tsx` | **Yes (this pass)** — both flag banners standardized to `shadow-elevation-1` + `border-flag/30`; `pullError`/`pulled` state banners also given `shadow-elevation-1` to match (this second part extends beyond the literal flag-banner instruction to the general state-banner rule above — flagged for confirmation, not silently assumed) | **Discrepancy:** this table previously said "Yes — internal `<h3>` sub-headings moved to `text-label`", but the file as currently pushed still shows `text-base font-semibold` on that heading. Needs reconciling — either the fix hasn't landed or this row was marked done prematurely. | Yes — padding/margin normalized to the §3 grid (confirmed by diff against the pre-202 version) |
| `Button.tsx` (EPOCH-203) | **Resolved (this pass)** — added `tone="danger"` on `outline`, replacing the two independent flat-border/hover-reveal patterns (DevicePullPanel.tsx's Homebrew fallback, WorkspaceView.tsx's Cancel button) with one elevation-based treatment, per this section's rule above | Yes — `text-label` adopted for all button text per §2's row above. Confirmed decision: keep as-is even though it visibly shrinks default-size CTA text versus the old `text-sm`; revisit later rather than block on it now | Yes — `px-4 py-3` / `px-3 py-2`, matching `DevicePullPanel.tsx`'s already-landed grid |

## 6. View layout — one gutter, one title, one left edge

Every sidebar-navigated view (`WorkspaceView`, `RunsView`, `RecordsView`,
`IocsView`, `ReportsView`) renders inside `ViewLayout`
(`components/layout/ViewLayout.tsx`), and switching views never moves the
content edge or the title (EPOCH-464).

- **Gutter:** the app shell's content area (`App.tsx`) is the only place a
  view's outer spacing is set: `p-8` (32px) on every side. A view sets no
  outer padding or margin of its own; doing so is what made the edge jump
  between 32px and 64px.
- **Title:** `ViewLayout` renders the view's one `text-display` title (§2) as
  an `h1` in the foreground colour, beside an icon chip in the view's section
  colour (§9), with 24px (`mb-6`) below the header. An optional description
  sits under it, and an optional aside (e.g. a count) beside it. Each view
  passes its `section`.
- **Width:** `full` by default. Form-like views use `readable`, which caps the
  width at `max-w-4xl` (896px) but stays left-aligned, so the left edge
  matches every other view. Views are never centered.
- **Height:** the content below the header is a flex column that fills the
  remaining height (`flex-1 min-h-0`). A view with a virtualized table passes
  `overflow-hidden` and gives the table `flex-1 min-h-0`, so the table's
  scrollport is bounded by the layout, never by a `calc(100vh - …)` constant.
- **No data:** every state with nothing to show (nothing selected, still
  loading, nothing found, evidence not registered) is an `EmptyState`
  (`components/ui/EmptyState.tsx`): centered in the space it fills, its icon
  (or a spinner while loading) in a chip of the view's section colour
  (`bg-section/20 text-section`, §9), the state as one `text-heading` line in
  the foreground colour, and an optional muted `text-data` detail. A view never
  shows a bare line of text for these. One exception: a view that is loading
  *into a table* shows a skeleton of that table (`TableSkeleton` in
  `components/ui/Skeleton.tsx`, as `RunsView` does), so the
  layout doesn't jump from a centered spinner to a full table when the rows
  arrive. Errors are not empty states: they use the flag banner (§1).

## 7. Capitalization and wording — names are Title Case, sentences are not

Decided 2026-10-09 (EPOCH-464), following the common desktop convention
(Apple Human Interface Guidelines, Microsoft Writing Style Guide).

- **Title Case for names:** page titles, sidebar items, section and card
  titles, dialog titles and buttons ("New Investigation", "Backups Found",
  "Pull Encrypted Backup"). Articles, coordinating conjunctions and
  prepositions of four letters or fewer stay lowercase unless first or last
  ("Pull from a Connected iPhone", "Install with Homebrew").
- **Sentence case for sentences:** descriptions, status lines, empty-state
  lines, banners and their headings, errors, field labels, tooltips and
  placeholders ("No investigation selected", "Setup failed", "Backup
  encryption password (required)").
- **A page's title is its sidebar label**, word for word, so the user always
  knows where they are.
- **Product names keep their own casing:** iPhone, iOS, iLEAPP.
- **Ellipsis:** the single character `…`, never three periods, for
  in-progress states ("Checking for the required tool…").
- **One term per concept:** the user-facing unit of work is an
  *investigation*; "run" is a pipeline term and doesn't appear in the UI's
  names.


## 8. Progressive disclosure — one step at a time, secrets only while needed

Decided 2026-10-11 (EPOCH-467), after a real-device pull: both import paths
were on screen at once, and the backup password was asked for before the
pull had anywhere to go.

- **Choose first.** Where a task has alternative paths (pull from a
  connected iPhone, or use an existing backup), the view asks which one
  before showing either. Choosing one hides the others; **Change** goes back
  to the choice.
- **Steps appear in order.** A step is shown once the steps before it are
  complete: device, then destination, then password, then the action.
- **Sensitive fields appear only while needed.** A password field appears
  only when the action that uses it is next, and is cleared when it is hidden
  or its inputs change (another device, another folder, another import path),
  and as soon as the action has taken it.
- **A running operation locks its inputs.** While it runs, the choice, its
  steps and Change are disabled, and leaving the view and coming back shows
  the operation still running (its state lives in the main process).

## 9. Colour roles — one meaning per colour

Decided 2026-10-12 (EPOCH-484), after the New Investigation page read as
dull: one cyan marked selection, progress, information and success alike (30
times as text on that page), the three surface tiers barely separated
(1.14:1 and 1.17:1), and 13 improvised surface opacities layered panels
unevenly.

**Each colour has one meaning.** A state uses its role's colour, never
another state's.

| Token | Means | Examples |
|---|---|---|
| `accent` | Interactive, selected, current, in progress | Primary button, selected device, the current step, a running pull or analysis |
| `success` | Done and verified | A backup verified as finished, installed tools, a completed step |
| `flag` | You must act, or caution | "Action Needed" on the iPhone, an unfinished backup, encryption consent |
| `danger` | Failed or destructive | A failed pull, setup failure, Delete |
| `foreground` / `muted-foreground` | Information | Notes, paths, explanations |

**Role tints have three strengths:** `/10` for a banner or row fill, `/20`
for an icon chip on a tinted banner, `/30` for a state banner's border (§1).

**Surfaces have four tiers, lightest on top:** `inset` (wells: logs, inputs,
command lines, progress tracks), `background` (the page), `surface` (cards),
`surface-raised` (panels inside a card). Components use these tokens, never a
`bg-surface/NN` opacity. The one exception is the dimmed scrim behind a
modal (`bg-background/80`).

**Contrast is measured, not judged.** Every role and section colour is at
least 4.5:1 (WCAG AA for body text) on every surface tier. Values on
2026-10-12, as contrast against inset / background / surface / surface-raised:

| Token | HSL | Contrast |
|---|---|---|
| `foreground` | 220 15% 92% | 16.1 / 15.6 / 13.7 / 11.2 |
| `muted-foreground` | 222 18% 68% | 8.1 / 7.8 / 6.9 / 5.7 |
| `accent` | 188 78% 52% | 9.9 / 9.6 / 8.4 / 6.9 |
| `success` | 152 60% 50% | 9.4 / 9.1 / 8.0 / 6.5 |
| `flag` | 36 90% 58% | 9.7 / 9.4 / 8.2 / 6.7 |
| `danger` | 4 85% 67% | 6.6 / 6.4 / 5.6 / 4.6 |
| `section-runs` | 268 80% 74% | 7.3 / 7.0 / 6.2 / 5.1 |
| `section-records` | 212 85% 66% | 7.4 / 7.2 / 6.3 / 5.2 |
| `section-iocs` | 326 75% 70% | 7.4 / 7.2 / 6.3 / 5.2 |
| `section-reports` | 244 80% 76% | 7.1 / 6.9 / 6.0 / 4.9 |

Text on a filled accent, success or danger button uses `background`: 9.6,
9.1 and 6.4:1. The tiers separate by 1.03 (inset to background), 1.14
(background to surface) and 1.22 (surface to raised).

**A secondary button is tinted, never surface-coloured** (EPOCH-506, decided
2026-10-14): `outline` is `bg-accent/15` with `text-accent`, so it reads as a
button on every tier, including the raised panels where a surface-coloured
button disappeared. Accent text on that fill is 7.7, 7.3, 6.2 and 5.1:1 on
inset, background, surface and surface-raised, and the fill stands 1.29 to
1.35:1 off each tier. A destructive one (`tone="danger"`: Delete It, Cancel) is
`bg-danger/15` with `foreground` text: danger text on that fill is only 3.8:1
on surface-raised, while foreground is 9.2 to 13.4:1.

The surface tiers are `inset` 6%, `background` 8%, `surface` 14% and
`surface-raised` 21% lightness, at hue 224, saturation 32%: deep blue ink
rather than grey, so the page itself carries colour. A new colour token is
added only with its contrast on every tier recorded here, and is defined in
`:root` so the light theme (§4) stays a same-file change.

**Each section has a colour.** The five sidebar sections each have an
identity colour, in the hue range 210–330 that no role uses, so a section
colour never reads as a state:

| Section | Token |
|---|---|
| New Investigation | `section-workspace` (the accent) |
| Investigations | `section-runs`, violet |
| Forensic Records | `section-records`, blue |
| Indicator Matches | `section-iocs`, pink |
| Reports | `section-reports`, periwinkle |

A section colour marks only where you are: the section's icon in the sidebar
(always), the current section's sidebar tint and bar, the view's title chip
and the soft glow behind its header, the view's empty states and its tip. It
is never used for a state, an action or data. Components use it as
`text-section` and `bg-section/NN`; `ViewLayout` sets `--section` for its view
(`components/layout/sections.ts`).

**The sidebar recedes.** The sidebar sits on `inset`, the darkest tier, so
the view beside it leads. Page titles are in the foreground colour, not the
accent: a title isn't interactive. The brand mark is the one gradient
(accent, blue, violet) in the app.

**Choices look choosable.** A selectable option (an iPhone to back up) is a
card with a 2px `accent/30` outline at rest, the full `accent` outline on
hover, and an `accent/10` fill with the `accent` outline once selected. Its
action reads **Select**, as a filled accent button, while choosing is the
current step. The current step's action is always the primary (filled)
button; it becomes an outline button once the step is done.

**Steps show their state.** A multi-step flow (§8) shows its steps as a
numbered rail: pending (muted), current (accent ring), done (success check),
blocked (flag). It is the shared `StepList` (EPOCH-455); the iPhone pull and
New Investigation use it (§10).

**Long steps show what they have done** (EPOCH-487). A step that runs for
minutes or hours says how far it has got and how long it has taken, never
only its name: bytes read, bytes written against a known size (with an
accent bar on an `inset` track, held below 100% until the step finishes), or
the item it is on ("module 212 of 540: <name>"). Prepare Evidence's backup
rows follow this rule.

**Applied so far:** the New Investigation page (`WorkspaceView`,
`DevicePullPanel`, `BackupProgressCard`, `BackupRow`, `ToolSetup`), and
app-wide the tokens, the sidebar, `ViewLayout`, `EmptyState` and `Badge`
(running is accent, succeeded and complete are success). The other views'
own panels still use surface opacities and adopt the roles as they are next
changed.

**A stage's state is one of seven chips** (EPOCH-559, U1; the board
"Investigations States and Rules"). The shared `StatusChip` is a rounded pill
in `text-label`, with its state written out, so colour is never the only
signal. `stageChip()` derives the state from the stage's recorded status and
why its run ended, never from text. The views adopt it in U3 (Investigations,
including the stage card) and U4; until then the stage card still shows its
raw status.

| Chip | Role | Shown when | Fill, text | Contrast on background / surface / raised |
|---|---|---|---|---|
| Complete | success | the stage succeeded | `success/10`, `success` | 7.8 / 6.6 / 5.4 |
| Complete with warnings | flag | it succeeded with warnings ("Complete, 2 warnings" once counted) | `flag/10`, `flag` | 8.0 / 6.9 / 5.6 |
| Skipped | neutral | it had nothing to work on; never shown as a clean result | `muted-foreground/14`, `foreground` | 12.4 / 10.6 / 8.7 |
| Interrupted | flag | it was pending or running when the examiner cancelled, or the app was closed (detail: "the app was closed") | `flag/10`, `flag` | 8.0 / 6.9 / 5.6 |
| Not started | muted | it was pending when the run ended any other way | `muted-foreground/8`, `muted-foreground` | 7.0 / 6.0 / 4.9 |
| Failed | danger | it failed, or was running when the run crashed or timed out | `danger/10`, `foreground`, with a `danger` × | 13.9 / 12.0 / 9.9 (× 5.7 / 4.9 / 4.1) |
| Running | accent | it is running in a live run | `accent/10`, `accent` | 8.1 / 7.0 / 5.7 |

Role chips use the `/10` row-fill strength. **Failed** uses `foreground` text
with a `danger` ×, not `danger` text, for the same reason as the destructive
button above. `danger` text measures 3.95:1 on its fill over `surface-raised`,
and stage cards sit on `surface-raised`. The × is a graphic, so it needs only
3:1 (WCAG 1.4.11). Danger is only for a failure; a stop the examiner asked
for is Interrupted.

**A chip's reason is written, never hover-only:** "Interrupted · the app was
closed", the reason in `muted-foreground` after a middle dot, so keyboard and
touch users read it too. `muted-foreground` on a `/10` role fill measures at
least 6.7 / 5.7 / 4.6 on background / surface / raised (flag 6.7 / 5.8 / 4.7,
danger 7.0 / 6.1 / 5.0).

**Keyboard focus is the accent** (EPOCH-558): every focusable element shows a
2 px `accent` outline, 2 px out, from one `:focus-visible` rule in
`index.css`. Inputs keep their accent border instead.

## 10. Step flows — the user always sees what is done and what comes next

Decided 2026-10-13 (EPOCH-497), after the first full run on a real backup:
"Prepare Evidence" stayed the main action once preparation was complete, and
read as needing to be run again; Analyze read like a separate feature rather
than the step that creates the investigation; and after a restart the page
forgot what was prepared. "We must guide clearly, or we look untrustworthy."

- **One rail per task.** A page that is one task shows its steps as a
  `StepList` at the top (§9): New Investigation's are Choose Evidence,
  Prepare Evidence and Analyze. Done steps read as done, not as actions.
- **State comes from the evidence, not memory.** What a step has done is read
  from the workspace (the completion markers), so a restart or another
  session shows the same state. New Investigation shows each backup as
  "Not prepared", "Partly prepared · prepare again" (flag) or
  "Prepared · <date>" (success).
- **The next step leads.** Once a step is done, its action becomes a
  secondary outline button with a name that says what it would do again
  ("Prepare Again", which redoes the step from the start), and the next
  step's action is the primary button.
- **An action says what it creates.** Analyze's button is "Analyze and Create
  Investigation", and its result points to the investigation ("Investigation
  created." then "View Investigation").
- **A finished long task hands over explicitly.** A finished iPhone pull shows
  a results card (device, size, finish time, folder) with one next action,
  "Continue to Prepare Evidence", instead of moving on by itself.
- **A card that opens looks like it opens, and one that doesn't, doesn't.**
  An investigation's stage cards open on click, Enter or Space, with a
  chevron; closed, they show the status and what the stage produced; open,
  what it read, what it wrote, exact times and its output (EPOCH-431). A card
  with nothing to open has no hover lift.

## 11. Dates and times — every time says its zone

Decided 2026-10-16 and 2026-10-18 by the project owner (EPOCH-559, EPOCH-560;
the board "Time Display Rules"). Times are stored in UTC (R11). This decides
only how they are shown.

- **Every date and time shows its zone.** The default is UTC. The examiner
  can choose a zone in Settings (EPOCH-560), and it then applies everywhere,
  the report included. The report's header names the zone.
- **One format:** a 24-hour clock with seconds, the value in monospace, and
  the zone beside it in muted `text-label`. Hovering shows the exact time
  with its offset.

  | Where | UTC (default) | A chosen zone |
  |---|---|---|
  | A date and time | `2026-10-08 00:36:36` UTC | `2026-10-07 19:36:36` CDT, UTC−05:00 |
  | A date | `2026-10-15` UTC | `2026-10-14` CDT, UTC−05:00 |
  | A log line | `15:21:03Z` | `10:21:03 CDT` |
  | Copied or exported | `2026-10-08T00:36:36Z` | `2026-10-07T19:36:36-05:00` |

- **A chosen zone's label includes its offset,** because on the night the
  clocks go back its name alone doesn't say which 01:30 is meant. A zone
  with no short name is labelled by its offset alone (`UTC+05:30`).
- **A recorded calendar date is shown as recorded, with no zone** (decided
  2026-10-18). A date with no time of day, such as the day an indicator feed
  was downloaded (a `DATE` column), is not an instant, so no zone can move it
  to another day: `2026-10-15`. The reader returns a `DATE` as its text
  (`readerTypes` in `packages/etl-db-reader`); the driver's default would make
  it the host's local midnight.
- **A time with no UTC offset is refused,** not read in the host's zone. Text
  must be full ISO 8601 with seconds and an offset (PostgreSQL's
  `2026-10-15 15:48:04+00` included); looser text that `Date` would accept is
  refused too.
- **Copied or exported times keep their milliseconds** when there are any
  (`2026-10-08T00:36:36.400Z`).
- **A missing time reads `no time recorded`.** It is never guessed.
- **Folder names stay compact UTC** (`2026-10-15T154804Z`), and durations
  are unchanged.
- **One implementation:** `shared/time.ts` (`formatDateTime`, `formatDate`,
  `formatLogTime`, `isoWithOffset`) and the `DateTime` component. A view never
  calls `toLocaleString` on a time.

