# Design

Paperwork uses neutral surfaces, compact typography, clear borders and emerald accents. Prioritize the next action and its evidence. Current gaps belong in [PROGRESS.md](PROGRESS.md).

## Colors

Tokens live in [src/web/styles.css](src/web/styles.css). Dark mode follows `prefers-color-scheme`.

| Token / purpose | Light | Dark |
| --- | --- | --- |
| `--bg` | `#f7f7f8` | `#09090b` |
| `--surface` | `#ffffff` | `#111114` |
| `--surface-2` | `#f4f4f5` | `#18181b` |
| `--border` | `#e6e6e9` | `#232328` |
| `--text` | `#0b0c0f` | `#f4f4f5` |
| `--muted` | `#71717a` | `#a1a1aa` |
| `--primary` | `#0b0c0f` | `#f4f4f5` |
| `--accent`, `--success` | `#059669` | `#34d399` |
| `--warning` | `#b45309` | `#fbbf24` |
| `--danger` | `#dc2626` | `#f87171` |
| `--info` | `#2563eb` | `#60a5fa` |

Use matching soft/ink tokens for alerts and badges. Primary buttons are neutral. Label states with text as well as color.

## Typography and spacing

- Inter → system sans; JetBrains Mono → system mono. Fonts use fallbacks unless separately loaded.
- Body: `14px/1.5`; page title: `22px/650`; section title: `15px/600`; subheading: `14px/600`; code: `12px` mono. Use tabular figures for amounts.
- Radius: `12px`, controls `8px`; stack gap: `16px`; card padding: `18px 20px`. Controls are generally `36px` tall; small buttons `30px`, full-width buttons `42px`.
- Dark mode disables surface-shadow tokens. PolicyCard retains its dark emerald/navy gradient, `16px` radius and custom shadow.

## Layout and components

Desktop: `232px` sidebar, page width up to `1160px`. Signing and Verify stand alone. Breakpoints: `1100px` reduces four-column stats to two; `860px` uses a sticky top bar/single column; `560px` stacks document/report layouts.

Reuse [shared React UI](src/web/components/ui.tsx), [SVG icons](src/web/components/icons.tsx), `PolicyCard`, `SignBox`, `JobWorkflow`, `Payouts` and `Account`. Extend existing components and plain CSS tokens before adding another styling system.

## Interaction and content

- Lead with the actor's next supported action. Keep source/terms visible for openings, private jobs and Market assignments.
- Before approval, show flags and proven payee, asset, amount and chain outside disclosures. Distinguish proposal, approval, processing, confirmed settlement and reported arrival. Funding implies no payment guarantee.
- Use direct labels: **Request changes**, **Refresh status**. Distinguish loading, empty, failed and stale states with recovery actions.
- `Button` guards awaited `onClick`; async forms need their own pending state. Preserve uncertain saved submissions.
- Escape and wrap untrusted content. Keep simulation notices visible.

## Accessibility and checks

Preserve keyboard focus, labelled controls, semantic links/buttons, `aria-current`, native disclosures and status announcements. Wrap long IDs/evidence. Check desktop/mobile and both color schemes for layout/token changes.

These requirements do not certify existing accessibility. Tab roles alone do not prove keyboard support; reduced-motion behavior needs verification.
