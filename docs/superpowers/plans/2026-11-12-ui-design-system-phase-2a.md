# UI Design System Phase 2A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-anchor RecoverEase's existing design tokens and typeface on the approved PDF (Figtree, blue `#2563EB`, teal, ink) without changing any component or page.

**Architecture:** One token file (`src/index.css`) already feeds every component, both themes and print. Phase 2A changes values in that file and the four places that repeat them (theme colour in `src/lib/theme.ts`, `index.html`, the manifest, `public/offline.html`). No second token system; token names stay.

**Tech Stack:** Tailwind CSS v4 `@theme`, `@fontsource-variable/figtree` 5.3.0 (self-hosted), Vitest, Playwright with axe.

**Spec:** the owner's Phase 2A brief (2026-11-12) and `RecoverEase-Dashboard-Redesign.pdf`. Base commit `03a184e`.

## Global Constraints

- Official light values: primary `#2563EB`, blue dark `#1D4FC4`, teal accent `#14B8A6` (shapes only), teal text `#0F766E`, soft blue `#E8F0FD`, soft teal `#E3F6F3`, ink `#0F2747`, muted `#4B5F7A`, page `#F5F8FC`, line `#DDE6F0`, amber `#8A4B0A` on `#FDF1E3`, alert `#8F2A17` on `#FBE9E5`.
- Official dark values: page `#0B1220`, surface `#121C2E`, soft blue `#16264A`, primary `#6B9BFF`, teal `#3CCFBC`, ink `#E8EEF8`, muted `#A3B3CC`, line `#243452`.
- Type: Figtree; page title 36/700, section title 22/700, body 17/400, helper 15/400.
- Every text pairing clears 4.5:1; icons and rings 3:1. Teal means success (no green). Red is the alert family only.
- White text never sits on a fill below 4.5:1. `Button` hard-codes white text and is out of scope, so dark-mode fills stay deep blue in 2A; the light-blue button with dark text is Phase 2B.
- Not touched: any file under `src/components`, `src/features`, `src/app`; navigation; status logic; API; database; Edge Functions.
- 12px classes (`text-xs`, `text-label-sm`, arbitrary sizes) stay for Phase 2B/2C. Do not claim the 14px floor.
- No commit, push, PR, merge or deploy without the owner's approval.

## Review Focus

- Light text steps on the official soft tints: `brand-600` on `brand-100` cannot clear 4.5:1; the rule is 600 on white, page and the 50 tint, 700 and 800 on the 100 tint. Pinned in Task 1.
- The patient's chat bubble (`fill-brand-600`) carries 70% white text, so it needs a deeper blue than the primary. Pinned by the existing bubble test.
- Text set at 15px and 17px instead of 14px and 16px can overflow at 320px. Checked by `e2e/responsive.spec.ts` and screenshots in Task 5.
- Printed reports must stay light: the paper block must restate every light value exactly. Pinned by the existing "paper" test.
- An installed app reads the manifest colours; they must equal the tokens. Pinned in Task 3.

---

### Task 1: Palette tests (red)

**Files:** Modify `tests/unit/theme-tokens.test.ts`.

- [x] Add `describe('the official palette')`: each official light and dark value above equals its token (`brand-600`, `brand-700`, `accent-500`, `accent-600`, `brand-50`, `accent-50`, `heading`, `body`, `muted`, `canvas`, `border`, `warning-700` on `warning-50`, `danger-700` on `danger-50`; dark `canvas`, `surface`, `surface-raised`, `brand-600`, `accent-600`, `heading`, `muted`, `border`).
- [x] Add: success tokens equal accent tokens in both themes (teal, no green).
- [x] Add: patient and clinician role accents resolve to brand; admin roles to neutral.
- [x] Add `describe('the light theme')`: the dark suite's text-on-surface matrix for LIGHT; 600/700/800 on the 50 tint, 700/800 on the 100 tint; `neutral-500` at 3:1.
- [x] Add: gradient tokens `gradient-from/via/to` equal `#2563eb`, `#1b8fcb`, `#14b8a6`; `.brand-gradient` uses only fill tokens.
- [x] Add: `--font-sans` starts with `'Figtree Variable'`; `--text-title` 2.25rem/700; `--text-headline-md` 1.375rem/700; `--text-base` 1.0625rem; `--text-sm` 0.9375rem; no `Inter` left in `index.css`.
- [x] Run `npx vitest run --project unit tests/unit/theme-tokens.test.ts`; expect the new tests to fail on old values.

### Task 2: Tokens and font (green)

**Files:** Modify `src/index.css`, `package.json`, `package-lock.json`.

- [x] `npm install --save-exact @fontsource-variable/figtree@5.3.0` and `npm uninstall @fontsource-variable/inter`.
- [x] Replace the font import, `--font-sans`, type roles, every colour token in `@theme`, the dark block, the paper block, role accents, shadows, dialog backdrop, print footer.
- [x] Run Task 1's command; expect all green.

### Task 3: Theme metadata (red, then green)

**Files:** Modify `tests/unit/pwa-manifest.test.ts`, `tests/unit/theme.test.tsx`, `src/lib/theme.ts`, `index.html`, `public/manifest.webmanifest`, `public/offline.html`.

- [x] Tests first: manifest `theme_color` `#2563eb` equals `--color-brand-600`; `background_color` `#f5f8fc` equals `--color-canvas`; theme colour meta is `#2563eb` in light and `#0b1220` in dark; `index.html` and `offline.html` carry `#2563eb` and no old hex.
- [x] Run, watch fail, change the five files, run again.

### Task 4: Documentation

**Files:** Modify `docs/ui-design.md`, `docs/architecture.md` (one line).

- [x] Rewrite Colour, Contrast, The gradient, Light/Dark/System, Typography to the new values, with the derived dark values and measured ratios, and a "Left for later phases" list.

### Task 5: Verification

- [x] `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run test:db`, `npm run verify`, `npm run test:e2e`; fix what the token change broke, report the rest by name.
- [x] Screenshots at 1280, 768, 375, 320 in Light, Dark and System against the local stub.
- [x] `/code-review` on the diff.
