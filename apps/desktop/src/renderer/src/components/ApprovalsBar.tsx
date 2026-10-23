import { api, errorMessage } from "../api.js";
import { useApp } from "../store.js";

/** Pending approvals are always visible: destructive actions need explicit consent (spec §22.3). */
export function ApprovalsBar() {
  const approvals = useApp((s) => s.approvals);
  const refresh = useApp((s) => s.refreshApprovals);
  const notify = useApp((s) => s.notify);
  if (approvals.length === 0) return null;

  async function decide(requestId: string, approved: boolean) {
    try {
      await api.invoke("approvals:decide", { requestId, approved });
    } catch (err) {
      notify("error", errorMessage(err));
    }
    await refresh();
  }

  return (
    <section className="ff-approvals" aria-label="Pending approvals">
      {approvals.map((a) => (
        <div key={a.requestId} className="ff-approval">
          <span className="ff-badge ff-tone-warning">
            <span aria-hidden="true">⚠</span> Approval required
          </span>
          <div className="ff-approval-body">
            <strong>{a.action}</strong>
            <small>
              {a.permission} · requested by {a.source}
            </small>
            {a.detail ? <pre className="ff-pre">{a.detail}</pre> : null}
          </div>
          <div className="ff-actions">
            <button type="button" className="ff-btn ff-btn-danger" onClick={() => void decide(a.requestId, true)}>
              Approve
            </button>
            <button type="button" className="ff-btn" onClick={() => void decide(a.requestId, false)}>
              Reject
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
