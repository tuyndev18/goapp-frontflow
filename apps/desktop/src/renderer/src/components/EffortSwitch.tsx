import type { CSSProperties } from "react";
import type { Effort } from "../lib/agentModels.js";

/**
 * Effort as a multi-position switch, like Claude Code's own model menu: one node per level on a
 * track (the default, `""`, first) and a knob that slides to the chosen one. A single slider for
 * the keyboard; the nodes are click targets only.
 */
export function EffortSwitch({
  levels,
  value,
  onChange,
  labelledBy,
  disabled,
}: {
  levels: Array<{ value: Effort; label: string }>;
  value: Effort;
  onChange(value: Effort): void;
  /** Id of the element naming the switch. */
  labelledBy: string;
  disabled?: boolean;
}) {
  const index = Math.max(0, levels.findIndex((e) => e.value === value));
  const choose = (i: number) => {
    const next = levels[Math.min(levels.length - 1, Math.max(0, i))];
    if (next && !disabled) onChange(next.value);
  };
  return (
    <div
      className="ff-effort"
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      aria-valuemin={0}
      aria-valuemax={levels.length - 1}
      aria-valuenow={index}
      aria-valuetext={levels[index]?.label}
      style={{ "--effort-at": index } as CSSProperties}
      onKeyDown={(e) => {
        const keys: Record<string, number> = { ArrowLeft: index - 1, ArrowDown: index - 1, ArrowRight: index + 1, ArrowUp: index + 1, Home: 0, End: levels.length - 1 };
        const to = keys[e.key];
        if (to === undefined) return;
        e.preventDefault();
        choose(to);
      }}
    >
      {levels.map((e, i) => (
        <button key={e.value || "default"} type="button" tabIndex={-1} aria-hidden="true" title={e.label} disabled={disabled} className={`ff-effort-node${e.value ? "" : " ff-effort-default"}`} onClick={() => choose(i)} />
      ))}
      <span className="ff-effort-knob" aria-hidden="true" />
    </div>
  );
}
