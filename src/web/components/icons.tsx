import type { SVGProps } from "react";

/** Small stroke icon set (24×24 grid, currentColor). */
const paths: Record<string, React.ReactNode> = {
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  shield: <path d="M12 3l7 3v6c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6l7-3z" />,
  shieldCheck: (
    <>
      <path d="M12 3l7 3v6c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6l7-3z" />
      <path d="M8.8 12.2l2.2 2.2 4.2-4.4" />
    </>
  ),
  shieldX: (
    <>
      <path d="M12 3l7 3v6c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6l7-3z" />
      <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </>
  ),
  wallet: (
    <>
      <path d="M4 7.5A2.5 2.5 0 016.5 5H18v3" />
      <rect x="4" y="8" width="16" height="11" rx="2.5" />
      <circle cx="16" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  pen: <path d="M14.5 5.5l4 4L9 19H5v-4l9.5-9.5zM12.5 7.5l4 4" />,
  file: (
    <>
      <path d="M7 3h7l5 5v11a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8-8M16 7l2 2M14 9l2 2" />
    </>
  ),
  coins: (
    <>
      <ellipse cx="12" cy="7" rx="6" ry="2.5" />
      <path d="M6 7v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V7M6 12v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-5" />
    </>
  ),
  bot: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 4v4M9 13h.01M15 13h.01M9.5 16.5h5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
    </>
  ),
  building: (
    <>
      <rect x="5" y="4" width="14" height="16" rx="1.5" />
      <path d="M9 8h2M13 8h2M9 12h2M13 12h2M10 20v-3h4v3" />
    </>
  ),
  pr: (
    <>
      <circle cx="7" cy="6" r="2" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="18" r="2" />
      <path d="M7 8v8M17 16V9a2 2 0 00-2-2h-4M13 5l-2 2 2 2" />
    </>
  ),
  play: <path d="M8 5.5v13l10.5-6.5L8 5.5z" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7.5a2 2 0 002 2h2.5" />
    </>
  ),
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4l9 16H3l9-16z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 6l12 12" />
    </>
  ),
  zap: <path d="M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z" />,
  snowflake: <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5L12 7l2.5-2.5M9.5 19.5L12 17l2.5 2.5" />,
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  book: <path d="M5 4.5h5.5A2.5 2.5 0 0113 7v13a2 2 0 00-2-2H5V4.5zM19 4.5h-3.5A2.5 2.5 0 0013 7v13a2 2 0 012-2h4V4.5z" />,
  activity: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  send: <path d="M20 4L9.5 14.5M20 4l-6.5 16-4-5.5L4 10.5 20 4z" />,
  fastForward: <path d="M4 6l8 6-8 6V6zM12 6l8 6-8 6V6z" />,
  link: <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}
