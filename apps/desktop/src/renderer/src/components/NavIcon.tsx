/** 16px stroke icons for the sidebar (they carry the nav when it is collapsed to icons only). */
const PATHS = {
  projects: <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />,
  accounts: (
    <>
      <circle cx="6" cy="5.5" r="2.3" />
      <path d="M1.8 13c.5-2.3 2.2-3.5 4.2-3.5s3.7 1.2 4.2 3.5" />
      <path d="M10.6 3.6a2.2 2.2 0 0 1 0 4M12.2 9.8c1.1.5 1.8 1.6 2 3.2" />
    </>
  ),
  usage: <path d="M2.5 13.5h11M4.5 11V8M8 11V4M11.5 11V6.5" />,
  skills: <path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8l4.2-1.3z" />,
  overview: (
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  run: <path d="M5 3.5v9l7-4.5z" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2" />
    </>
  ),
  collapse: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M6 2.5v11M10.5 6.5 9 8l1.5 1.5" />
    </>
  ),
  expand: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M6 2.5v11M9 6.5l1.5 1.5L9 9.5" />
    </>
  ),
} as const;

export type NavIconName = keyof typeof PATHS;

export function NavIcon({ name }: { name: NavIconName }) {
  return (
    <svg className="ff-nav-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
