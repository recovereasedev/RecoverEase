# UI design

Implements the approved **Clinical Clarity** design system
(`clinical_clarity/DESIGN.md` in the Stitch export). Its stated intent is a
high-trust healthcare aesthetic — calm, authoritative, human-centred — reached
through tonal layering and a systematic approach to information density,
rather than through gradients, glass or ornament.

Tokens live in [`src/index.css`](../src/index.css) as Tailwind v4 `@theme`
variables. Components reference semantic tokens, never a raw hex value or a
scale step. That single seam is what let the palette be replaced wholesale
without editing a component.

## Colour

The design system's roles, mapped onto the token layer:

| Role | Token | Value |
| --- | --- | --- |
| `primary` — key actions, page titles, active navigation | `--color-brand-800` | `#004269` |
| `primary-container` — solid fills, hover | `--color-brand-600` | `#0e5a8a` |
| `secondary` — teal, interactive emphasis and confirmation | `--color-accent-700` | `#006b5f` |
| `surface-container-lowest` — cards, content containers | `--color-surface` | `#ffffff` |
| `background` — page floor | `--color-canvas` | `#f9f9ff` |
| `surface-container-low` — wells, table headers | `--color-surface-sunken` | `#f0f3ff` |
| `surface-container` — icon tiles, active nav, tonal chips | `--color-surface-raised` | `#e7eeff` |
| `on-surface` — headings | `--color-heading` | `#111c2d` |
| `on-surface-variant` — body copy | `--color-body` | `#41474f` |
| `error` | `--color-danger-600` | `#ba1a1a` |
| `tertiary` — amber, warnings | `--color-warning-700` | `#7e4900` |

Neutrals are a blue-tinted slate taken from the system's tonal surface
containers. Cooler than a true grey, which is what makes stacked panels read
as layers rather than as dirt on the screen.

### Contrast

Every foreground/background pair used for text was measured against WCAG AA
(4.5:1) and the ratio is recorded beside the token:

| Pair | Ratio | |
| --- | ---: | --- |
| `heading` (`#111c2d`) on white | 17.10:1 | AAA |
| `brand-800` on white | 10.59:1 | AAA |
| `body` (`#41474f`) on white | 9.38:1 | AAA |
| `accent-800` on white | 9.37:1 | AAA |
| `danger-800` on white | 9.35:1 | AAA |
| `warning-800` on white | 9.35:1 | AAA |
| `success-700` on white | 7.76:1 | AAA |
| `brand-600` on white | 7.37:1 | AAA |
| `danger-600` on white | 6.46:1 | AA |
| `accent-700` on white | 6.43:1 | AA |
| `muted` (`#5f6672`) on white | 5.78:1 | AA |
| `muted` on `surface-raised` | 4.98:1 | AA |

### One deliberate departure

The design system's `outline` is `#717880`. On white that is **4.47:1**, on
the canvas 4.26:1, and on a tinted container 3.84:1 — below AA for normal text
in all three.

It is kept as `--color-outline` for what it is genuinely for — hairlines,
disabled glyphs, placeholder text, all of which WCAG exempts — and
`--color-muted` is set one step darker at `#5f6672`. Secondary text is most of
the text in a clinical interface; it has to pass. Accessibility outranks an
exact hex, and this is the kind of detail that silently fails an audit if it
is not written down.

`neutral-400` (`#9aa1ad`, 2.60:1) is likewise decorative only — chevrons and
empty-state glyphs, never text and never the sole carrier of meaning.

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

The design document calls for a blue-to-teal gradient "in selected areas". It
is used in exactly two places:

1. The brand mark.
2. The brand panel on the auth and landing pages.

Nowhere else. The `.brand-gradient` utility carries a comment saying so. Kept
scarce, it functions as identity; applied to cards and headers it becomes
decoration and stops meaning anything.

## Typography

**Inter**, named by the design system for its legibility in data-heavy
clinical screens. It is **self-hosted** via `@fontsource-variable/inter`
rather than pulled from a font CDN, for two reasons: a patient portal should
not send every visitor's IP and referrer to a third party on page load, and a
bundled font has no external failure mode. Subsets are `unicode-range` gated,
so an English session downloads one 48KB file. The full system stack remains
the fallback.

The scale is the design system's, exposed as Tailwind text steps:

| Step | Size / line height | Used for |
| --- | --- | --- |
| `text-headline-xl` | 36 / 44, −0.02em, 700 | Page titles, `sm:` and up |
| `text-headline-lg` | 28 / 36, −0.01em, 600 | Page titles on mobile |
| `text-headline-md` | 20 / 28, 600 | Section headings |
| `text-body-lg` | 18 / 28 | Lead paragraphs |
| `text-body-md` | 16 / 24 | Body — the floor |
| `text-body-sm` | 14 / 20 | Dense data tables |
| `text-label-md` | 14 / 20, +0.05em, 600 | Emphasised labels |
| `text-label-sm` | 12 / 16, 500 | All-caps section anchors |

The landing page hero is the one place the scale is exceeded: `headline-xl`
on a phone, and a larger explicit size from `sm`. A marketing hero is allowed
to be bigger than a page title; everything below it on that page is on the
steps above.

A "strong" hierarchy — large contrast between heading and body — is what lets
a clinician scan a record instead of reading it. Page titles are set in brand
blue and section headings in the heading colour; that separation is what lets
section headings stay small without the page losing its structure.

All-caps is used only for short labels, never for prose: capitals destroy word
shape and slow reading.

- Body text has a **16px floor**. Nothing clinical is set smaller.
- Line height 1.5 for body, 1.25 for headings.
- Headings use `text-wrap: balance`, body uses `text-wrap: pretty`, so titles
  do not leave a single orphaned word.
- **Tabular numerals** on tables and anything marked `data-numeric`. Doses,
  times and dates must align vertically to be scannable in a column — a real
  clinical-software detail, not a flourish.

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
| `--radius-xs` | 4px | Inline code, tiny chips |
| `--radius-sm` | 6px | Skeleton blocks, focus ring |
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
| `SectionHeading` | Icon tile + title + description above a group of cards |
| `Eyebrow` | The small all-caps label above a page or section title |
| `StatCard` | One measurement in a bento row: label, number, trend, footer |
| `ProgressBar` / `ProgressRing` | A rate, always restating a number written nearby |
| `Notice` | Guidance, a safety note, or the outcome of an action |
| `Skeleton` family | Load placeholders that reserve the real content's space |
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

`StatCard` is deliberately narrow: a label, a number, an optional trend and a
footer sentence. It will not take an action, a chart or a paragraph, because a
row of four cards that each do something different stops being scannable —
which was the only reason to use cards instead of a list.

## Motion

Short and functional: 120ms for micro-interactions, 180ms for panels. Motion
signals a state change; it never decorates.

`prefers-reduced-motion: reduce` collapses every animation and transition to
0.01ms globally. Motion is an enhancement, never a requirement.

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

- **No meaningless metric tiles.** `StatCard` exists, but the rule governing
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
- **No decorative charts.** The two visualisations that exist —the goal
  progress bar and the mood trend— each restate their value in text beside
  them, and the mood trend ships a screen-reader table of the same data.
- **Mood trend is columns, not a line.** With at most fourteen points on a
  five-point scale, a line implies a precision and continuity the data does
  not have: a patient does not glide from "okay" to "good" overnight.
- **No fake data on the landing page.** The product preview shows *structure*
  — doses due, next appointment, a goal — and no invented adherence
  percentages. A health product should not teach visitors to read numbers that
  are not real.
- **No glassmorphism, no decorative blobs, no gradient surfaces.**
- **Light theme only.** Dark mode was not requested and doubles the QA
  surface; the design system specifies a light clinical palette. Tokens are
  structured so it could be added later without touching component code.

## Voice

- Plain language. "Mark taken", not "Record administration".
- Sentence case throughout.
- Errors say what happened and what to do next. Raw Postgres text is never
  shown: "new row violates row-level security policy" becomes "You do not have
  access to this", with the technical detail available in development only.
- Empty states explain what will appear and, where there is one, offer the
  action that fills them.
