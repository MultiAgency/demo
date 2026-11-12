import type { Deliverable } from "../types";
import { Icon, type IconName } from "./icons";
import { dateText, short, usd } from "./ui";

export interface PolicyCardProps {
  payee: string;
  scope: Pick<Deliverable, "value_usd">[];
  start: string;
  end: string;
  repos: string[];
  approver?: string;
  status?: "draft" | "live" | "frozen" | "ended";
  agentId?: string | null;
  /** On the platform stand-in nothing is enforced by a real platform: say so instead of claiming it. */
  standIn?: boolean;
  reportWorkflow?: boolean;
}

/** The contract rendered as the platform policy it becomes. */
export function PolicyCard(p: PolicyCardProps) {
  const values = p.scope.map((d) => Number(d.value_usd) || 0);
  const total = values.reduce((a, b) => a + b, 0);
  const largest = values.length ? Math.max(...values) : 0;
  // locked: written into the platform policy (or the app's consent). Funding is what the company deposits, not a limit.
  const rows: { icon: IconName; label: string; value: string; locked: boolean }[] = [
    { icon: "user", label: "Pays only", value: p.payee || "—", locked: true },
    { icon: "zap", label: "One payment", value: largest ? `≤ ${usd(largest)}` : "—", locked: true },
    { icon: "check", label: "Approves each", value: p.approver || "The company", locked: true },
    { icon: "calendar", label: "Can pay until", value: p.end ? dateText(p.end) : "—", locked: true },
    { icon: "coins", label: "Funded with", value: total ? `${usd(total)}, the scope` : "—", locked: false },
  ];
  const status = p.status ?? "draft";
  return (
    <div className={`policy-card policy-${status}`}>
      <div className="policy-top">
        <div>
          <div className="policy-kicker">Job agent</div>
          <div className="policy-id" title={p.agentId ?? undefined}>{p.agentId ? short(p.agentId, 10, 6) : status === "draft" ? "Not created yet" : "—"}</div>
        </div>
        <span className="policy-status">
          <span className="policy-dot" />
          {status === "draft" ? "Preview" : status === "live" ? "Live" : status === "frozen" ? "Frozen" : "Ended"}
        </span>
      </div>
      <ul className="policy-rows">
        {rows.map((r) => (
          <li key={r.label}>
            <span className="policy-label">
              <Icon name={r.icon} size={14} />
              {r.label}
            </span>
            <span className="policy-value">{r.value}</span>
            {r.locked ? <Icon name="lock" size={13} className="policy-lock" /> : <Icon name="info" size={13} className="policy-lock" aria-label="Information: the company could deposit more" />}
          </li>
        ))}
      </ul>
      <div className="policy-foot">
        <span>
          <Icon name="shieldCheck" size={14} /> {p.standIn ? "Platform stand-in: simulated, not a real platform" : "Locked rows: the MultiAgency platform's policy"}
        </span>
      </div>
      <div className="policy-app">
        <div className="policy-app-label">{p.reportWorkflow ? "Proposed from the builder report and invoice" : "Judged by Paperwork on every merge"}</div>
        <div className="policy-app-row">
          <Icon name="pr" size={14} />
          {p.scope.length} deliverable{p.scope.length === 1 ? "" : "s"}
          <span className="sep">·</span>
          {p.repos.filter(Boolean).join(", ") || "—"}
          <span className="sep">·</span>
          from {p.start ? dateText(p.start) : "—"}
        </div>
      </div>
    </div>
  );
}
