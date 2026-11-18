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
  chat: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M4 5.5h16v10H9l-5 4v-14Z" />
      <path d="M8 9.5h8M8 12.5h5" />
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
  database: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <ellipse cx="12" cy="5.5" rx="7" ry="2.5" />
      <path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13" />
      <path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
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
  bookmark: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M6.5 3.5h11v17L12 16.5l-5.5 4z" />
    </Icon>
  ),
  book: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M12 6.5C10.5 5 8.5 4.5 4 4.5v14c4.5 0 6.5.5 8 2 1.5-1.5 3.5-2 8-2v-14c-4.5 0-6.5.5-8 2Z" />
      <path d="M12 6.5v14" />
    </Icon>
  ),
  sliders: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
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
  more: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="5" cy="12" r="1.25" fill="currentColor" /><circle cx="12" cy="12" r="1.25" fill="currentColor" /><circle cx="19" cy="12" r="1.25" fill="currentColor" />
    </Icon>
  ),
  "chevron-down": (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  ),
  "chevron-right": (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  ),
  "chevron-left": (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="m15 6-6 6 6 6" />
    </Icon>
  ),
  x: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  ),
  check: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  ),
  "check-circle": (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="9" /><path d="m8.5 12.3 2.4 2.4 4.6-4.8" />
    </Icon>
  ),
  info: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><path d="M12 7.6v.1" />
    </Icon>
  ),
  external: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
    </Icon>
  ),
  copy: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" /><path d="M15.5 8.5V5.5A1.5 1.5 0 0 0 14 4H5.5A1.5 1.5 0 0 0 4 5.5V14a1.5 1.5 0 0 0 1.5 1.5h3" />
    </Icon>
  ),
  clipboard: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <rect x="5" y="5" width="14" height="16" rx="2" /><path d="M9 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" /><path d="M9 11h6M9 15h4" />
    </Icon>
  ),
  upload: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M12 15V4" /><path d="m7.5 8.5 4.5-4.5 4.5 4.5" /><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
    </Icon>
  ),
  download: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M12 4v11" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
    </Icon>
  ),
  key: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="8" cy="15" r="4" /><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2" />
    </Icon>
  ),
  "user-plus": (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="10" cy="8" r="3.5" /><path d="M3.5 20a6.5 6.5 0 0 1 13 0" /><path d="M19 8v6M16 11h6" />
    </Icon>
  ),
  building: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M5 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16" /><path d="M15 10h3a1 1 0 0 1 1 1v10" /><path d="M3.5 21h17" /><path d="M8.5 8h3M8.5 12h3M8.5 16h3" />
    </Icon>
  ),
  globe: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </Icon>
  ),
  "git-branch": (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="6" cy="5.5" r="2.5" /><circle cx="6" cy="18.5" r="2.5" /><circle cx="18" cy="7.5" r="2.5" /><path d="M6 8v8" /><path d="M18 10c0 4-4 4.5-10.2 6.8" />
    </Icon>
  ),
  filter: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8z" />
    </Icon>
  ),
  sort: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M7 4v16M3.5 7.5 7 4l3.5 3.5" /><path d="M17 20V4M13.5 16.5 17 20l3.5-3.5" />
    </Icon>
  ),
  refresh: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M20 11A8 8 0 0 0 5.6 6.4L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.4 4.6L20 16" /><path d="M20 20v-4h-4" />
    </Icon>
  ),
  pencil: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M15.5 5.5 18.5 8.5" /><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z" />
    </Icon>
  ),
  move: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M12 3v18M3 12h18" /><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
    </Icon>
  ),
  undo: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Icon>
  ),
  help: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6" /><path d="M12 17.2v.1" />
    </Icon>
  ),
  bot: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 4v4" /><circle cx="12" cy="3.5" r="0.5" fill="currentColor" /><path d="M9 13v1.5M15 13v1.5" /><path d="M2 12.5v3M22 12.5v3" />
    </Icon>
  ),
  message: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M5 19.5V6.5A1.5 1.5 0 0 1 6.5 5h11A1.5 1.5 0 0 1 19 6.5v8a1.5 1.5 0 0 1-1.5 1.5H9z" />
    </Icon>
  ),
  mail: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" />
    </Icon>
  ),
  pause: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M9 5v14M15 5v14" />
    </Icon>
  ),
  play: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M7 4.5v15l12-7.5z" />
    </Icon>
  ),
  keyboard: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6.5 14h11" />
    </Icon>
  ),
  "folder-plus": (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" /><path d="M12 11v5M9.5 13.5h5" />
    </Icon>
  ),
  "eye-off": (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M10.6 5.1A9.7 9.7 0 0 1 12 5c6 0 9.5 7 9.5 7a16.6 16.6 0 0 1-2.6 3.4" /><path d="M6.6 6.6C3.9 8.4 2.5 12 2.5 12s3.5 7 9.5 7a9.4 9.4 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /><path d="m3 3 18 18" />
    </Icon>
  ),
  minus: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M5 12h14" />
    </Icon>
  ),
  "zoom-in": (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M11 8v6M8 11h6" />
    </Icon>
  ),
  "zoom-out": (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M8 11h6" />
    </Icon>
  ),
  fit: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
    </Icon>
  ),
  quote: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M5 18c2.5-1 4-3 4-6V7H5v5h4" /><path d="M15 18c2.5-1 4-3 4-6V7h-4v5h4" />
    </Icon>
  ),
  heading: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M6 4v16M18 4v16M6 12h12" />
    </Icon>
  ),
  bold: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M7 4h6a4 4 0 0 1 0 8H7z" /><path d="M7 12h7a4 4 0 0 1 0 8H7z" />
    </Icon>
  ),
  italic: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M10 4h8M6 20h8M14 4l-4 16" />
    </Icon>
  ),
  code: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />
    </Icon>
  ),
  "code-block": (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" /><path d="m9.5 9.5-2.5 2.5 2.5 2.5M14.5 9.5l2.5 2.5-2.5 2.5" />
    </Icon>
  ),
  list: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M9 6h11M9 12h11M9 18h11" /><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </Icon>
  ),
  "list-ordered": (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M10 6h10M10 12h10M10 18h10" /><path d="M4 4.5h1.5V9M4 9h3M4 14.5a1.5 1.5 0 0 1 3 0c0 1.5-3 2-3 4h3" />
    </Icon>
  ),
  /** An issue in a tracker (Jira, Linear): a ticket stub with a perforation. */
  ticket: (p: SVGProps<SVGSVGElement>) => (
    <Icon {...p}>
      <path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4Z" />
      <path d="M14 7.5v1.5M14 11.25v1.5M14 15v1.5" />
    </Icon>
  ),
};

export type IconName = keyof typeof icons;

/**
 * An icon. Decorative (aria-hidden) by default; with `label` it is announced as an image with that name.
 * Sizes (SPEC §3.10): 16 in UI, 14 in badges, 20 in the tab bar and header buttons, 32 in empty states.
 */
export function I({ name, size = 16, label, className }: { name: IconName; size?: number; label?: string; className?: string }) {
  const C = icons[name];
  return label ? (
    <C width={size} height={size} className={className} role="img" aria-label={label} aria-hidden={undefined} focusable="false" />
  ) : (
    <C width={size} height={size} className={className} focusable="false" />
  );
}
