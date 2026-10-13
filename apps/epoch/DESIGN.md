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
  *into a table* shows a skeleton of that table (as `RunsView` does), so the
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
- **Product names keep their own casing:** iPhone, iOS, iLEAPP, mvt-ios.
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
blocked (flag). The iPhone pull uses it (`PullSteps`).

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
