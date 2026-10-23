/**
 * Loading state: the FrontFlow mark drawing itself (stem → branch → nodes) with a ripple, plus a shimmering label.
 * `screen` fills the main area while a screen has no data yet; otherwise it sits inline in a panel.
 */
export function Loading({ label = "Loading", screen }: { label?: string; screen?: boolean }) {
  return (
    <div className={screen ? "ff-loading ff-loading-screen" : "ff-loading"} role="status" aria-live="polite">
      <div className="ff-loader" aria-hidden="true">
        <span className="ff-loader-ripple" />
        <span className="ff-loader-ripple" />
        {/* Same geometry as BrandMark (resources/logo-mark.svg), split so each part animates on its own. */}
        <svg className="ff-loader-mark" viewBox="0 0 64 64">
          <rect width="64" height="64" rx="15" />
          <path className="ff-loader-stem" pathLength={1} d="M19 50V27a9 9 0 0 1 9-9h15" />
          <path className="ff-loader-branch" pathLength={1} d="M19 43a9 9 0 0 1 9-9h6" />
          <circle className="ff-loader-node ff-loader-node-1" cx="44" cy="18" r="6" />
          <circle className="ff-loader-node ff-loader-node-2" cx="36" cy="34" r="5" />
        </svg>
      </div>
      <div className="ff-loading-text">
        <span className="ff-loading-label">{label}</span>
        <span className="ff-loading-dots">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}
