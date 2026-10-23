/** FrontFlow mark: an "F" drawn as workflow branches ending in nodes. Source: apps/desktop/resources/logo-mark.svg. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="ff-brand-mark" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="var(--primary)" />
      <g fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 50V27a9 9 0 0 1 9-9h15" />
        <path d="M19 43a9 9 0 0 1 9-9h6" />
      </g>
      <circle cx="44" cy="18" r="6" fill="#fff" />
      <circle cx="36" cy="34" r="5" fill="#fff" />
    </svg>
  );
}
