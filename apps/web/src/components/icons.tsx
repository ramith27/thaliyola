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
  chart: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M4 20V4M4 20h16" />
      <path d="M8 16v-4M12 16V8M16 16v-6" />
    </Icon>
  ),
};

export type IconName = keyof typeof icons;

export function I({ name, size = 18 }: { name: IconName; size?: number }) {
  const C = icons[name];
  return <C width={size} height={size} />;
}
