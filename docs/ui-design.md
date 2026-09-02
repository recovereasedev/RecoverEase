# UI design

Implements the RecoverEase **User Interface Design** document. That document
sets out six colour roles, a sans-serif hierarchy, rounded containers,
generous whitespace, and three governing principles: **clarity, simplicity,
accessibility**.

Tokens live in [`src/index.css`](../src/index.css) as Tailwind v4 `@theme`
variables. Components reference semantic tokens, never a raw hex value or a
scale step.

## Colour

The document's table, mapped one-to-one:

| Document role | Token | Value |
| --- | --- | --- |
| Blue — branding, navigation, important elements | `--color-brand-600` | `#2563eb` |
| Teal — buttons, highlights, emphasis | `--color-accent-700` | `#0f766e` |
| White — content areas, cards, forms | `--color-surface` | `#ffffff` |
| Light gray — page backgrounds | `--color-canvas` | `#f8fafc` |
| Dark gray — headings and primary text | `--color-heading` | `#0f172a` |
| Muted gray — secondary text, labels | `--color-muted` | `#64748b` |

Neutrals use a cool slate rather than a warm gray, which reads as clinical
instrumentation rather than consumer software.

### Contrast

Every foreground/background pair used for text was measured against WCAG AA
(4.5:1) and the ratio is recorded beside the token:

| Pair | Ratio |
| --- | ---: |
| `brand-600` on white | 5.17:1 |
| `accent-700` on white | 5.29:1 |
| `muted` (`neutral-500`) on white | 4.76:1 |
| `heading` (`neutral-900`) on white | 17.85:1 |
| `danger-700` on white | 5.94:1 |
| `warning-700` on white | 4.52:1 |
| `success-700` on white | 4.83:1 |

**`accent-600` (`#0d9488`) is 3.94:1 and is not used for text.** It appears
only as icon and rule colour. Teal's usable-for-text floor is 700, and this is
the kind of detail that silently fails an audit if it is not written down.

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

A system font stack, not a webfont:

```
ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, …
```

This renders natively on every target platform with no network request, no
layout shift on load, and no failure mode when a font CDN is unreachable.
Legibility at small sizes is what matters clinically, and the platform stacks
are designed for exactly that.

- Body text has a **16px floor**. Nothing clinical is set smaller.
- Line height 1.5 for body, 1.25 for headings.
- Headings use `text-wrap: balance`, body uses `text-wrap: pretty`, so titles
  do not leave a single orphaned word.
- **Tabular numerals** on tables and anything marked `data-numeric`. Doses,
  times and dates must align vertically to be scannable in a column — a real
  clinical-software detail, not a flourish.

## Elevation

Separation is done with **borders**, not shadows.

In an interface that shows many panels at once, a shadow on everything reads
as noise and stops signalling anything. Shadow is reserved for genuinely
floating layers — dropdown, dialog, drawer, toast — so elevation keeps its
meaning.

## Radius

The document asks for rounded containers; the four steps keep it restrained:

| Token | Size | Used for |
| --- | --- | --- |
| `--radius-sm` | 6px | Badges, small inputs |
| `--radius-md` | 8px | Buttons, inputs |
| `--radius-lg` | 12px | Cards, panels |
| `--radius-xl` | 16px | Dialogs |

Fully rounded pills are reserved for avatars and count badges.

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

## What was deliberately avoided

The brief asked for real healthcare software, not a generic AI dashboard:

- **No meaningless metric tiles.** Every number on a dashboard is one the user
  can act on. There is no "total patients seen" counter.
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
  surface; the design document specifies a light clinical palette. Tokens are
  structured so it could be added later without touching component code.

## Voice

- Plain language. "Mark taken", not "Record administration".
- Sentence case throughout.
- Errors say what happened and what to do next. Raw Postgres text is never
  shown: "new row violates row-level security policy" becomes "You do not have
  access to this", with the technical detail available in development only.
- Empty states explain what will appear and, where there is one, offer the
  action that fills them.
