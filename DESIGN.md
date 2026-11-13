# Design

Paperwork uses warm ivory surfaces, compact typography, clear borders and Solaria gold accents. Prioritize the next action and its evidence. Current gaps belong in [PROGRESS.md](PROGRESS.md).

## Colors

Tokens live in [src/web/styles.css](src/web/styles.css). Dark mode follows `prefers-color-scheme`.

| Token / purpose | Light | Dark |
| --- | --- | --- |
| `--bg` | `#faf8f2` | `#15120d` |
| `--surface` | `#ffffff` | `#1d1912` |
| `--surface-2` | `#f5f0e5` | `#262117` |
| `--border` | `#e5ddcd` | `#373022` |
| `--text` | `#292216` | `#f5f0e5` |
| `--muted` | `#786b56` | `#ad9f86` |
| `--primary` | `#f5d68f` | `#f5d68f` |
| `--accent` | `#896015` | `#f5d68f` |
| `--success` | `#059669` | `#34d399` |
| `--success-ink` (text on `--success-soft`) | `#047857` | `#34d399` |
| `--warning` | `#b45309` | `#fbbf24` |
| `--danger` | `#dc2626` | `#f87171` |
| `--danger-ink` (text on `--danger-soft`) | `#b91c1c` | `#f87171` |
| `--info` | `#2563eb` | `#60a5fa` |

Use matching soft/ink tokens for alerts and badges. Primary buttons use Sherwin-Williams Solaria-inspired `#f5d68f` with dark brown text. Gold links and focus indicators use a darker shade in light mode for contrast. Success remains green. Label states with text as well as color.

## Typography and spacing

- Roboto → system sans for the interface; Roboto Slab Bold for the Paperwork wordmark. Both load through Google Fonts. JetBrains Mono → system mono for code.
- Body: `14px/1.5`; page title: `22px/650`; section title: `15px/600`; subheading: `14px/600`; code: `12px` mono. Use tabular figures for amounts.
- Radius: `12px`, controls `8px`; stack gap: `16px`; card padding: `18px 20px`. Desktop controls are generally `36px` tall; small buttons `30px`, full-width buttons `42px`. Phone/coarse-pointer controls use at least `44px` targets; phone text inputs use `16px` type.
- Dark mode disables surface-shadow tokens. PolicyCard uses a dark warm brown gradient, ivory text and gold details, with a `16px` radius and custom shadow. Avatars and the welcome glow use Solaria gold; the favicon matches the legal-paper logo.

## Layout and components

Desktop: `232px` sidebar, page width up to `1160px`. Signing and Verify stand alone. Breakpoints: `1100px` moves split previews below forms and reduces four-column stats to two; `860px` uses a sticky top bar with labelled navigation; `560px` stacks document/report layouts and agency job rows. Organization and platform identifiers wrap. Material disclosures use `--muted`, with body-text contrast.

Reuse [shared React UI](src/web/components/ui.tsx), [SVG icons](src/web/components/icons.tsx), `PolicyCard`, `SignBox`, `JobWorkflow`, `Payouts` and `Account`. Extend existing components and plain CSS tokens before adding another styling system.

## Interaction and content

- Lead with the actor's next supported action. Keep source/terms visible for openings, private jobs and Market assignments.
- Before approval, show flags and proven payee, asset, amount and chain outside disclosures. Distinguish proposal, approval, processing, confirmed settlement and reported arrival. Funding implies no payment guarantee.
- Use direct labels: **Request changes**, **Refresh status**. Distinguish loading, empty, failed and stale states with recovery actions.
- `Button` guards awaited `onClick`; async forms need their own pending state. Preserve uncertain saved submissions.
- Escape and wrap untrusted content. Keep simulation notices visible.

## Accessibility and checks

Preserve keyboard focus, labelled controls, semantic links/buttons, `aria-current`, native disclosures and status announcements. Wrap long IDs/evidence. Check desktop/mobile and both color schemes for layout/token changes.

Job tabs support Arrow keys, Home and End with one tab stop and a labelled panel. Progress, loading and submission updates have accessible names/statuses. Both shells include a skip link and main landmark; route changes focus the page heading. Private-route browser titles use generic job labels. Tabs wrap and payment figures remain readable when scaled. Reduced-motion preferences shorten animations/transitions.

`bun run test:accessibility` checks keyboard interactions, axe WCAG rules in light/dark themes, Chromium accessibility trees, 200% CSS zoom and 320px reflow, and failure recovery across both workflows. Automated results do not certify accessibility or replace actual VoiceOver/NVDA and native browser zoom walkthroughs.
