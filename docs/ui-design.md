# UI design

Implements the approved design, **RecoverEase-Dashboard-Redesign.pdf**
("Calm, caring, clear"). Its test is that a recovering patient knows what to
do within three seconds, and its four rules are: one main action per screen,
fewer words, encourage and never scold, easy to read and tap.

Tokens live in [`src/index.css`](../src/index.css) as Tailwind v4 `@theme`
variables. Components reference semantic tokens, never a raw hex value. That
single seam is what let the palette and the typeface be replaced without
editing a component.

The redesign is landing in phases. This document describes what the tokens
are now; [Left for later phases](#left-for-later-phases) lists what the
design asks for that the components do not do yet.

## Colour

The design's named colours, and the token each one is:

| Design name | Value | Token |
| --- | --- | --- |
| Primary blue: buttons, active | `#2563EB` | `--color-brand-600`, `--color-fill-brand-800` |
| Blue dark: links, pressed | `#1D4FC4` | `--color-brand-700`, `--color-fill-brand-700` |
| Teal accent: shapes only, not words | `#14B8A6` | `--color-accent-500` |
| Teal text: "Taken", success | `#0F766E` | `--color-accent-600`, `--color-success-600` |
| Soft blue: active navigation, fills | `#E8F0FD` | `--color-brand-50`, `--color-surface-raised` |
| Soft teal: taken, encouragement | `#E3F6F3` | `--color-accent-50`, `--color-success-50` |
| Ink: text | `#0F2747` | `--color-heading`, `--color-body` |
| Muted: helper text | `#4B5F7A` | `--color-muted` |
| Page | `#F5F8FC` | `--color-canvas` |
| Cards | `#FFFFFF` | `--color-surface` |
| Line: borders | `#DDE6F0` | `--color-border` |
| Amber: late | `#8A4B0A` on `#FDF1E3` | `--color-warning-700` on `--color-warning-50` |
| Alert: emergencies only | `#8F2A17` on `#FBE9E5` | `--color-danger-700` on `--color-danger-50` |
| Logo gradient | `#2563EB`, `#1B8FCB`, `#14B8A6` | `--color-gradient-from`, `-via`, `-to` |

The design names fourteen colours and the components use eleven-step scales,
so the steps between the named ones are **derived**: tints and shades of the
named colour in the same family, with no new hue. Derived light values are
the other steps of `brand`, `accent`, `neutral`, `warning` and `danger`,
plus `--color-surface-sunken` (`#EDF2F8`), `--color-border-strong`
(`#C5D1E0`) and `--color-outline` (`#6B7C95`).

Three decisions the design makes that the tokens encode:

- **Teal is what done looks like.** There is no green: every `success` token
  is the `accent` token of the same step.
- **Amber is for late; red is for emergencies only.** The `danger` family is
  the design's alert colour.
- **One blue for the people the design was drawn for.** The role accent is
  blue for patients and clinicians, and slate for the Clinic Admin and Super
  Admin consoles, so an administrative screen never reads as a clinical one.

### Contrast

Every pairing used for text clears WCAG AA (4.5:1) and icons clear 3:1, in
both themes. `tests/unit/theme-tokens.test.ts` measures them from
`src/index.css` itself. Light theme, measured:

| Pair | Ratio |
| --- | ---: |
| Ink on white / on the page | 14.98 / 14.07 |
| Muted on white / page / soft blue | 6.53 / 6.13 / 5.69 |
| Primary blue on white / page / soft blue | 5.17 / 4.85 / 4.51 |
| Blue dark on white / soft blue | 7.08 / 6.17 |
| Teal text on white / soft teal | 5.47 / 4.88 |
| Amber on its tint | 6.10 |
| Alert on its tint | 7.12 |
| White on the primary button (`fill-brand-800`) | 5.17 |
| White on the button hovered (`fill-brand-700`) | 7.08 |

### Where the design's own colours would fail, and what the tokens do

The design was checked before it was copied. Four of its combinations do not
clear 4.5:1, and in each the token keeps the text readable:

| Combination in the design | Ratio | What the tokens do |
| --- | ---: | --- |
| White text on the logo gradient, middle and teal end | 3.60 and 2.49 | The gradient tokens are for shapes. Text sits on `.brand-gradient`, primary blue to teal text, 5.17 or better along its length. |
| White on the dark theme's primary `#6B9BFF` | 2.71 | In dark mode `#6B9BFF` is a text and outline colour. Fills under white text stay `#2563EB` (5.17). See Left for later phases. |
| Teal accent `#14B8A6` as text | 2.49 | `accent-500` is never a text step; teal text is `accent-600`. |
| Primary blue on a tint deeper than soft blue | 4.15 on `brand-100` | On a `-100` tint, text is the 700 or 800 step. The 600 step is for white, the page and the `-50` tint. |

Two more that are not text:

- The patient's chat bubble carries its time stamp in white at 70%, which
  needs a deeper blue than the primary: `fill-brand-600` is `#1C4BB8`
  (7.64 under white).
- `neutral-500` (`#6B7C95`, 4.25 on white) is for icons and `neutral-400`
  (2.56) is decorative only. Neither is a text colour; secondary text and
  placeholders are `--color-muted`.

### Colour is never the only signal

Roughly one man in twelve has a colour vision deficiency; a red dot beside a
green dot is indistinguishable to them. Every status in the system is defined
in [`src/lib/status.ts`](../src/lib/status.ts) as **label + icon + tone**:

```ts
export const medicationLogStatus = {
  taken:  { label: 'Taken',  icon: CheckCircle2,   tone: 'success' },
  missed: { label: 'Missed', icon: AlertTriangle,  tone: 'warning' },
  …
}
```

`StatusBadge` renders all three. Even in `iconOnly` mode — used in dense
tables — the label stays available to assistive technology, so the status
never degrades into an unlabelled coloured dot.

Because the map is keyed on the generated database enum types, adding a value
to a database enum without describing it here is a **compile error**.

## The gradient

Royal blue `#2563EB`, sky `#1B8FCB`, teal `#14B8A6`: taken from the logo, and
kept as `--color-gradient-from`, `-via` and `-to`. The design uses it on the
hero card, the logo and progress fills, and says "never behind small text".

Two gradients therefore exist, for two jobs:

1. **The logo gradient** (the three tokens): shapes only.
2. **`.brand-gradient`**: the sign-in panel and the landing page's closing
   band, which carry white text. It runs from primary blue to teal text
   (`fill-brand-800` to `fill-accent-600`), so white on it is 5.17:1 or
   better everywhere.

The brand mark in the shell uses the second pair of stops as well, so its
white pulse line clears 4.5:1 at both ends.

## Light, Dark and System

The theme control sits at the foot of the sidebar and the phone drawer:
Light, Dark or System, which follows the device's own setting and keeps
following it. The choice is remembered on the device (`localStorage`,
`src/lib/theme.ts`) and applied by the startup module before the first
render. That module runs once the page has been parsed, so with Dark chosen,
or System on a dark device, a page can briefly show the default light theme
before the chosen one is applied. Until someone chooses, it is Light.

The browser's address bar follows the theme: `#2563EB` in Light, `#0B1220`
in Dark. The installed app's manifest uses `#2563EB` and the page
`#F5F8FC`, and the offline page uses the same light values.

Dark mode is the same tokens with other values (`src/index.css`, under
`:root[data-theme='dark']`), not a filter. The design names eight dark
colours:

| Design name | Value | Token |
| --- | --- | --- |
| Page | `#0B1220` | `--color-canvas` |
| Surface | `#121C2E` | `--color-surface` |
| Soft blue | `#16264A` | `--color-brand-50`, `--color-surface-raised` |
| Primary | `#6B9BFF` | `--color-brand-600` |
| Teal | `#3CCFBC` | `--color-accent-600`, `--color-success-600` |
| Ink | `#E8EEF8` | `--color-heading`, `--color-body` |
| Muted | `#A3B3CC` | `--color-muted` |
| Line | `#243452` | `--color-border` |

It does not name dark values for amber, alert, soft teal, or the steps
between. Those are **derived** around the eight, in the same hue as their
light counterpart, and each was measured:

| Derived dark value | Token | Measured |
| --- | --- | --- |
| Amber text `#EFB25C`, `#F4C47C`, `#F8D59E` | `warning-600`, `-700`, `-800` | 9.09 on surface; 8.68 on its tint |
| Amber tints `#2A1E0D`, `#392911` | `warning-50`, `-100` | |
| Alert text `#FF9C8C`, `#FFB1A4`, `#FFC7BD` | `danger-600`, `-700`, `-800` | 8.44 on surface; 8.37 on its tint |
| Alert tints `#2E1613`, `#3E1D18` | `danger-50`, `-100` | |
| Soft teal `#0E2A2C`, `#11363A` | `accent-50`, `-100` | Teal `#3CCFBC` on them: 7.82, 6.72 |
| Lighter blues `#8DB2FF`, `#B0C9FF` | `brand-700`, `-800` | 8.08 on surface |
| Blue tint `#1A2F5E` | `brand-100` | Primary `#6B9BFF` on it: 4.81 |
| Sunken surface `#0E1627` | `surface-sunken` | Muted on it: 8.49 |
| Hover fill `#18233A` | `neutral-100` | |
| Stronger line `#34476A` | `border-strong` | |
| Icons `#8292AD` | `neutral-500`, `outline` | 5.41 on surface; 4.73 on soft blue |

Measured for the named ones: ink on page 16.06 and on surface 14.63; muted
on page 8.81, surface 8.02 and soft blue 7.00; primary on surface 6.30 and
on soft blue 5.50; teal on surface 8.81.

A solid fill with white text on it cannot turn light in dark mode, so fills
are tokens of their own (`fill-brand-800`, `fill-danger-600`,
`fill-brand-deep` for the chat header and the rest). They are the same deep
colours in both themes, each 4.5:1 or better under white. Shadows follow
the theme only in their token form, `shadow-[var(--shadow-lg)]`: Tailwind
copies a bare `shadow-lg`'s light value into the utility when it builds.

Two places stay light in either theme: a report sheet, which stands for
paper on screen (`data-theme-scope="light"`), and everything printed.

Checked twice: `tests/unit/theme-tokens.test.ts` pins the design's named
values and measures every pairing from the token values in both themes,
including states a page check cannot see, such as a hovered button's
translucent tint or the ring that marks the chosen theme;
`e2e/contrast-audit.spec.ts` runs axe's contrast rule over every role's main
screens in both themes, in a real browser, and over the states the default
data does not reach: a reminder card on screen, the assistant turned off,
and the Super Admin's switch off or being turned off.

## Typography

**Figtree**, the typeface the design names. It is **self-hosted** via
`@fontsource-variable/figtree` rather than pulled from a font CDN, for two
reasons: a patient portal should not send every visitor's IP and referrer to
a third party on page load, and a bundled font has no external failure mode.
One variable file carries every weight. The full system stack remains the
fallback, and is what the offline page uses unless the device has Figtree.

The design gives four sizes, and the steps are built on them:

| Step | Size / line height | Used for |
| --- | --- | --- |
| `text-title` | 36 / 44, −0.02em, 700 | Page titles, `sm:` and up |
| `text-headline-xl` | 36 / 44, −0.02em, 700 | Landing section headings and the auth brand panel |
| `text-headline-lg` | 28 / 36, −0.01em, 700 | Page titles on mobile, headline figures |
| `text-headline-md` | 22 / 28, 700 | Section headings |
| `text-body-lg` | 18 / 28 | Lead paragraphs |
| `text-body-md`, `text-base` | 17 / 26 | Body |
| `text-body-sm`, `text-sm` | 15 / 22 | Helper text |
| `text-label-md` | 15 / 22, +0.05em, 600 | Emphasised labels |
| `text-label-sm`, `text-xs` | 12 / 16 | Not yet raised; see below |

`text-base` and `text-sm` are Tailwind's own names for the body and helper
sizes. Setting them to 17px and 15px moved every screen at once, without a
component choosing a size of its own.

The landing page hero is the one place the scale is exceeded: `headline-xl`
on a phone, `text-display-sm` (48px) from `sm` and `text-display` (56px) from
`xl`.

Page titles and section headings are both set in ink, not blue: blue is kept
for what can be acted on. All-caps is used only for short labels, never for
prose.

- Line height 1.5 for body, 1.25 for headings.
- Headings use `text-wrap: balance`, body uses `text-wrap: pretty`, so titles
  do not leave a single orphaned word.
- **Tabular numerals** on tables and anything marked `data-numeric`. Doses,
  times and dates must align vertically to be scannable in a column.

## Left for later phases

The tokens are the foundation. The design also asks for these, which are
component work and are **not done**:

- **The 14px floor.** `text-xs` and `text-label-sm` are still 12px, and a
  few components set smaller sizes of their own: 78 uses in 26 files,
  including the phone's bottom bar, the mood labels, the calendar and the
  chat. The bottom bar's labels were measured to fit at 12px, so raising
  them needs the bar redesigned, not a token change.
- **The light-blue button in dark mode.** The design's dark primary is
  `#6B9BFF`, which needs dark text (`#0B1220` on it is 6.92:1). `Button`
  sets white text, so until it is restyled the dark theme's buttons are
  `#2563EB` under white.
- **Button radius 14px and the 20px hero card.** `--radius-md` is still 8px.
- **Status pills, the hero card, the pulse line, illustrated empty states.**
- **"Not taken" and "Running late"** in place of "Missed" and "Overdue" on
  patient screens, and red kept for emergencies: the labels and tones in
  `src/lib/status.ts` are unchanged.
- **Illustrations.** The design shows a set of nine. No source files were
  supplied, so none are in the application.

## Elevation

Depth is **tonal**, not shadowed. The canvas is the floor; a white card sits
on it behind a hairline border; nested groupings step down onto
`surface-sunken` and tiles step up onto `surface-raised`.

Shadow is the design system's "lifted" state and is spent sparingly: the
restrained `0 4px 12px` at 8% is reserved for genuinely floating layers —
dropdown, dialog, drawer, toast — plus `Card variant="elevated"`, which marks
the one card on a screen that is asking for an action right now. A shadow on
everything reads as noise and stops signalling anything.

## Radius

An 8px base, which softens the institutional feel of healthcare software while
staying structured:

| Token | Size | Used for |
| --- | --- | --- |
| `--radius-xs` | 4px | The printed report: sheet, tiles, tables |
| `--radius-sm` | 6px | Focus ring, inline link targets, small chips |
| `--radius-md` | 8px | Buttons, inputs, nav items |
| `--radius-lg` | 16px | Cards, panels, modals |
| `--radius-xl` | 24px | Large panels |

**Badges are fully rounded**, which is what keeps them from being mistaken for
buttons: in this language a pill states a fact and an 8px rectangle performs
an action. Pills are otherwise reserved for avatars and count badges.

## Component vocabulary

Beyond the base primitives, the design system's recurring patterns exist once
each rather than being re-cut per page:

| Component | What it is for |
| --- | --- |
| `PageSection` | A titled section of a page: a `<section>` landmark named by its own heading, with no container of its own |
| `SectionHeading` | The 20px heading and optional description that `PageSection` renders; no icon tile |
| `StatBand` | A row of related counts as one band divided by hairlines: a number, what it counts, an optional trend and one line of context |
| `ProgressBar` / `ProgressRing` | A rate, always restating a number written nearby |
| `Notice` | Guidance, a safety note, or the outcome of an action |
| `LoadingState` | The announced loading state for a page or panel |
| `DataTable` family | Clinical tables: tinted header, horizontal rules only, own scroll container |
| `ListRow` / `ListRows` | The something / detail / status / action row, stacked on a phone and inline from `sm` |

A table that has to survive a phone is written **once**, not twice. The audit
log restyles a single `<table>` into stacked labelled rows below `md` rather
than rendering a card list beside a table: two copies put every value in the
document twice, which assistive technology reads in some modes and which is
indefensible on a page whose entire purpose is an exact record of what
happened. Changing `display` on a table element strips its implicit
semantics, so the ARIA roles are written out explicitly and the structure
survives the restyle.

`StatBand` is deliberately narrow: a number, what it counts, an optional
trend and at most one line of context. It will not take an action, a chart or
a paragraph. It replaced a row of separate stat cards, each with its own
border and icon tile: four cards read as four things competing for attention,
where one band reads as one summary, which is what a row of related counts
is.

## Motion

Short and functional: 120ms for micro-interactions, 180ms for panels. Motion
signals a state change; it never decorates.

`prefers-reduced-motion: reduce` collapses every animation and transition to
0.01ms globally. Motion is an enhancement, never a requirement.

The landing page, being marketing, has the one longer motion: each section
rises 12px into place over 480ms the first time it scrolls into view
(`useRevealOnScroll`, an IntersectionObserver - never a scroll listener). It
is opt-in by construction: nothing is hidden until the hook has switched it
on, it is never switched on under reduced motion, and what is already on
screen is never hidden at all. The hero's heading is not animated. The
header gains a shadow once the page has scrolled under it.

## Charts

The recovery progress panel (`src/features/recovery-progress`), on My
recovery and at the top of a patient record's Recovery tab, is the
application's one set of charts. Its rules:

- **Hand-built SVG, no chart library.** Drawn at the container's measured
  size, so axis text stays at the size it is set in. 240px tall from `sm`,
  180px on a phone.
- **One period scopes everything.** The 7 / 30 day control sits above all
  of it; there is no per-chart filter. Seven days is today and the six before
  it, in local time, as the 7-day adherence windows already are.
- **Missing is never zero.** A line stops at a day without a value and starts
  again after it, and is never drawn across the gap. A day with no resolved
  dose gets a small hollow ring on the baseline instead of a bar; a genuine
  0% is a thin cap on the baseline - a different shape, not only a different
  colour. No value is interpolated or carried forward.
- **Fixed axes.** Mood is always 1–5; percentages are always 0–100%. An axis
  fitted to the data would make a flat week look like a swing.
- **One mark colour.** Every chart draws in `brand-600`, which the dark theme
  re-tones (7.4:1 on the light surface, 7.8:1 on the dark). The three
  indicators are never on one chart, so they need no palette of their own -
  and three hues from these ramps fail a colour-blind separation check.
  Headline numbers are text in `text-heading`, never in the mark colour.
- **Every value without a pointer.** A chart is one tab stop: the arrow keys,
  Home and End step through the days, each announced through a polite live
  region (deliberately not `role="status"`, so a page's own status line stays
  unique). The tooltip shows the same reading, beside the day and inside the
  chart. A "Show the data table" button gives every day as a table.
- **No chart motion.** Clinicians open these many times a day, and data being
  read should not move for style. Switching period holds the previous chart,
  dimmed, until the new one has arrived, rather than flashing a loading state.
- **The arithmetic lives in `progress.ts`**, and its rules are on screen
  beside the chart: a day's overall score is the mean of whichever of mood
  (1 → 0%, 5 → 100%) and resolved-dose adherence it has; the headline is the
  mean of the days plotted; coverage says how many days that is. Treatment
  goals are a current snapshot, labelled as such, because a goal stores no
  date it was achieved.

## Accessibility, structurally

These are enforced by the primitives rather than left to each page:

- **Focus is always visible.** A global `:focus-visible` rule sets a 2px
  brand-coloured ring with 2px offset. Component styles cannot override it
  away — an invisible focus ring makes the app unusable by keyboard, which is
  a failure, not a style preference.

  The rule is **unlayered**, deliberately, which puts it above every cascade
  layer including Tailwind's utilities. Two things depend on that. The first
  is the guarantee above: a rule in `@layer base` loses to any utility, so
  before this it held only by convention. The second was found by measuring
  rather than looking — `transition-colors` includes `outline-color`, so on
  any control carrying it the ring animated from the element's own text colour
  to the brand blue over 120ms. Reading the computed style immediately after a
  Tab returned `rgb(255,255,255)` on the sign-in button: white, on a white
  page. Someone tabbing at speed never saw a full-contrast ring on the app's
  most important control. The rule restates the transition set without
  `outline-color`, so hover and border transitions still run.
- **Labels are always visible.** `Field` renders a real `<label>` bound with
  `htmlFor`. A placeholder is not a label: it disappears the moment someone
  types, which is exactly when a user filling in a long clinical form needs to
  check what a field asked for.
- **Errors sit beside their field**, wired with `aria-describedby`, carrying
  `role="alert"` so they are announced when they appear after a failed submit.
  Invalid fields carry `aria-invalid`, so the error is conveyed by more than a
  red border.
- **Required is a word, not an asterisk.** `Field` renders a visual `*` plus
  a screen-reader-only "(required)".
- **Dialogs use native `<dialog>`** with `showModal()`, which gives focus
  trapping, Escape-to-close, the top layer and the backdrop from the platform.
  Hand-rolled modals are where focus escapes to the page behind.
- **Tabs follow the ARIA pattern** — roving `tabindex`, arrow/Home/End
  navigation, one tab stop. Making every tab tabbable forces a keyboard user
  to walk through all of them to reach the panel.
- **A skip link** is the first focusable element on both the app shell and the
  landing page.
- **Loading is announced**, not just spun. `LoadingState` uses
  `role="status"` + `aria-busy`; `Button` sets `aria-busy` and a
  screen-reader-only label.

## Responsive behaviour

Adapted, not shrunk:

| Breakpoint | Navigation | Tables |
| --- | --- | --- |
| `< 768px` | Bottom bar, five destinations | Become cards |
| `768–1023px` | Drawer via menu button | Tables |
| `≥ 1024px` | Persistent sidebar | Tables |

- The bottom bar caps at **five items** because narrower targets stop being
  reliably tappable, and it respects `env(safe-area-inset-bottom)` so it
  clears the iOS home indicator.
- Touch targets are **44px** at the default button size (40px for the `sm`
  variant used inside table rows, where the row provides extra hit area).
- Tables become cards below `md`. A table squeezed onto a phone forces
  horizontal scrolling, which is the pattern that makes clinical software
  unusable on a ward round.
- Zoom is never suppressed; the viewport meta sets no `maximum-scale`.

### Authentication screens

Built mobile-first rather than as a shrunken desktop composition:

| Breakpoint | Composition |
| --- | --- |
| `< 640px` | Single column, form directly on the canvas, compact brand lockup |
| `640–1023px` | Same column, form lifted into a card |
| `≥ 1024px` | Two columns: gradient brand panel beside the form card |

Three decisions carry that:

- **No card around the form on a phone.** A card at 375px spends 32px of a
  335px column separating the form from nothing — it is the only thing on
  screen. The card earns its place at `sm`, where a 448px column floating on
  an empty background does need anchoring.
- **Centred with `my-auto`, not `justify-center`.** A centred flex item that
  grows taller than its container overflows in *both* directions and the top
  becomes unreachable, because no scrollbar reaches above the start of a
  scroll box. That is what happens on a 375×812 phone once the keyboard takes
  half the viewport. `my-auto` collapses to zero when there is no spare room,
  so the layout falls back to scrolling from the top instead of clipping.
- **List rows stack, they do not wrap.** Doses, prescriptions, appointments,
  journal entries and notifications are all the same shape: a thing, its
  detail, its status, and what you can do about it. Every one of them had
  hand-rolled a `flex flex-wrap`, which at 375px put the buttons underneath
  the text but left-aligned against it, so the row read as two unrelated
  things. `ListRow` makes the stack deliberate — text, then status and actions
  on their own line — and collapses to a single line from `sm`. Nothing is
  hidden at either size: a patient on a phone is not a patient who needs less.
- **Small buttons are 44px on a phone.** `Button size="sm"` is meant for
  controls inside a row, where a desktop row gives extra hit area and a phone
  gives none. It is `h-11` up to `sm` and `h-10` from there. Tabs follow the
  same rule.
- **An inline link that is the way somewhere is a 44px target on a phone.**
  Breadcrumbs, and a patient's name in a schedule row, are how a clinician
  gets into and out of a record on a ward round. As bare inline text they
  measured 20px. They carry `min-h-11` up to `sm` and drop it from there,
  where a pointer makes 20px fine and the extra row does not earn its space.
  This is the one that instrumentation catches and screenshots do not: the
  link looks perfectly normal at every width.
- **"Forgot your password?" sits below the submit button.** On the password
  label row it saves a row of vertical space, but it also lands between the
  email and password fields in the tab order — so a keyboard user filling the
  form in tabs onto a link that navigates away mid-entry. Below the button the
  sequence is email, password, reveal, Sign in, which is the order the form is
  actually completed in.

## What was deliberately avoided

The brief asked for real healthcare software, not a generic AI dashboard:

- **No meaningless metric tiles.** `StatBand` exists, but the rule governing
  its use has not changed: every number on a dashboard is one the user can act
  on. There is no "total patients seen" counter and no invented adherence
  percentage.
- **None of the design comps' invented clinical content.** The comps carry
  MRNs, NPI numbers, FIDO2 enrolment, a Merkle audit ledger, caregiver
  proxies, VAS pain scores and post-op day counters. RecoverEase has none of
  those concepts. The visual language was adopted; the fabricated record was
  not. The shell's context strip names the portal you are signed in to — a
  fact the application actually holds — rather than the comps' "Active Post-Op
  Pathway".
- **No decorative charts.** Every visualisation —the goal progress bar, the
  overview's mood trend and the recovery progress charts (below)— restates
  its value in text beside it, and each chart has a table of the same data.
- **The overview's mood trend is columns, not a line.** With at most fourteen
  points on a five-point scale, a line implies a precision and continuity the
  data does not have: a patient does not glide from "okay" to "good"
  overnight. The recovery progress panel's mood chart *is* a line, as the
  2nd-half plan's reference design draws it, and answers the same objection
  differently: it never joins two days across a day without a rating, so a
  line only ever connects consecutive recorded days.
- **No fake data on the landing page.** The product preview shows *structure*
  — doses due, next appointment, a goal — and no invented adherence
  percentages. A health product should not teach visitors to read numbers that
  are not real. Real screens captured with a fictional patient are marked
  "Sample data"; the two examples drawn on the page (the hero's day card and
  the dose schedule) are marked "Illustrative example" and hold no working
  control. The hero portrait is a clinician, not a named member of anyone's
  staff. The Stitch landing design's copy was adopted only where the
  application does what it says: its calendar sync, offline notifications,
  e-mailed invitations, "cryptographic" enforcement and "24/7" were not.
- **No glassmorphism, no decorative blobs, no gradient surfaces.**
- **A dark theme by default.** Dark mode exists (below), but a new visitor
  starts in Light, the clinical palette the design system specifies, until
  they choose otherwise.

## Voice

- Plain language. "Mark taken", not "Record administration".
- Sentence case throughout.
- Errors say what happened and what to do next. Raw Postgres text is never
  shown: "new row violates row-level security policy" becomes "You do not have
  access to this", with the technical detail available in development only.
- Empty states explain what will appear and, where there is one, offer the
  action that fills them.
