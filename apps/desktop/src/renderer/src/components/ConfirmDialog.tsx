import { useEffect, useRef, type ReactNode } from "react";

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} className="ff-dialog" onCancel={(e) => (e.preventDefault(), onCancel())} aria-labelledby="ff-dialog-title">
      <h2 id="ff-dialog-title">{title}</h2>
      <div className="ff-dialog-body">{children}</div>
      <div className="ff-dialog-actions">
        <button type="button" className="ff-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={`ff-btn ${danger ? "ff-btn-danger-solid" : "ff-btn-primary"}`} onClick={onConfirm} disabled={busy}>
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
