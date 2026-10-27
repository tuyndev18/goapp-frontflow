import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

export interface MenuItem {
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Set on every item of a menu that picks one value: the picked one is marked. */
  checked?: boolean;
  onSelect(): void;
}

/** A button that opens a small list of actions under it. */
export function Menu({ label, trigger, className, disabled, items }: { label: string; trigger: ReactNode; className: string; disabled?: boolean; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useDismiss(root, open, () => setOpen(false));
  return (
    <span className="ff-menu" ref={root}>
      <button type="button" className={className} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </button>
      {open ? (
        <div className="ff-menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role={item.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={item.checked}
              className={`ff-menu-item${item.danger ? " ff-menu-danger" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <span>
                {item.label}
                {item.checked ? " ✓" : ""}
              </span>
              {item.hint ? <small>{item.hint}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

/** Closes a popover on Escape or a click outside `root`. */
export function useDismiss(root: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [root, open, close]);
}
