import type { VisualStateSpec } from "./node-state.js";

export interface StatusBadgeProps {
  spec: VisualStateSpec;
  /** Extra text after the label, e.g. "attempt 2/3". */
  suffix?: string;
  compact?: boolean;
}

export function StatusBadge({ spec, suffix, compact }: StatusBadgeProps) {
  return (
    <span
      className={`ff-badge ff-tone-${spec.tone}${spec.animated ? " ff-animated" : ""}${compact ? " ff-compact" : ""}`}
      role="status"
      aria-label={suffix ? `${spec.label}, ${suffix}` : spec.label}
    >
      <span className="ff-badge-icon" aria-hidden="true">
        {spec.icon}
      </span>
      <span className="ff-badge-label">{spec.label}</span>
      {suffix ? <span className="ff-badge-suffix">{suffix}</span> : null}
    </span>
  );
}

export function AssumedBadge() {
  return (
    <span className="ff-badge ff-tone-assumed" aria-label="Contains assumptions">
      <span className="ff-badge-icon" aria-hidden="true">
        ≈
      </span>
      <span className="ff-badge-label">Assumed</span>
    </span>
  );
}
