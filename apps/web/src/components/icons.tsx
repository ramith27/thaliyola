import type { SVGProps } from "react";

/** A small line-icon set (24px grid, 1.75 stroke), drawn inline so it follows the text color. */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export const icons = {
  home: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20h14V9.5" />
      <path d="M10 20v-6h4v6" />
    </Icon>
  ),
  search: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Icon>
  ),
  graph: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <circle cx="9" cy="18" r="2.5" />
      <path d="M8.3 7.1 15.6 7.6M7 8.3l1.4 7.3M16.4 10l-5.6 6.4" />
    </Icon>
  ),
  review: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M9 11.5 11 13.5 15.5 9" />
      <rect x="4" y="4" width="16" height="16" rx="3" />
    </Icon>
  ),
  plug: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M9 3v4M15 3v4" />
      <path d="M6 7h12v3a6 6 0 0 1-12 0V7Z" />
      <path d="M12 16v5" />
    </Icon>
  ),
  team: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.5a3 3 0 0 1 0 5.5M17.5 14a5.5 5.5 0 0 1 3 5" />
    </Icon>
  ),
  library: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M5 4h3v16H5zM10 4h3v16h-3z" />
      <path d="m15.5 5 2.9-.8 3.1 15.4-2.9.8z" />
    </Icon>
  ),
  folder: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </Icon>
  ),
  lock: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Icon>
  ),
  plus: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  ),
  doc: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M7 3h7l5 5v13H7z" />
      <path d="M14 3v5h5M10 13h6M10 17h6" />
    </Icon>
  ),
  bolt: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />
    </Icon>
  ),
  alert: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M12 4 2.8 19.5h18.4L12 4Z" />
      <path d="M12 10v4.5M12 17.2v.1" />
    </Icon>
  ),
  inbox: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M4 13 6.5 5h11L20 13v6H4z" />
      <path d="M4 13h4.5l1 2h5l1-2H20" />
    </Icon>
  ),
  shield: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M12 3 5 6v5.5c0 4.3 2.9 8 7 9.5 4.1-1.5 7-5.2 7-9.5V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </Icon>
  ),
  rss: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14" />
      <circle cx="6" cy="18" r="1.2" />
    </Icon>
  ),
  trash: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" />
    </Icon>
  ),
  user: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </Icon>
  ),
  settings: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </Icon>
  ),
  logout: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 16l-4-4 4-4M6 12h10" />
    </Icon>
  ),
  menu: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </Icon>
  ),
  table: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M4 10h16M10 10v9" />
    </Icon>
  ),
  bell: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </Icon>
  ),
  eye: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  ),
  sun: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </Icon>
  ),
  moon: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </Icon>
  ),
  monitor: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </Icon>
  ),
  star: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z" />
    </Icon>
  ),
  link: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </Icon>
  ),
  chart: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M4 20V4M4 20h16" />
      <path d="M8 16v-4M12 16V8M16 16v-6" />
    </Icon>
  ),
  image: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m20.5 16-5-5-8.5 8.5" />
    </Icon>
  ),
  clock: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Icon>
  ),
  share: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </Icon>
  ),
  sparkle: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M12 3.5 13.8 10.2 20.5 12l-6.7 1.8L12 20.5l-1.8-6.7L3.5 12l6.7-1.8L12 3.5Z" />
    </Icon>
  ),
  hash: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M9 4 7 20M17 4l-2 16M4.5 9h16M3.5 15h16" />
    </Icon>
  ),
  arrow: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Icon>
  ),
  history: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
      <path d="M3.5 4v4h4M12 8v4l3 2" />
    </Icon>
  ),
};

export type IconName = keyof typeof icons;

export function I({ name, size = 18 }: { name: IconName; size?: number }) {
  const C = icons[name];
  return <C width={size} height={size} />;
}
