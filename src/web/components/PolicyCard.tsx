import type { Deliverable } from "../types";
import { Icon, type IconName } from "./icons";
import { dateText, usd } from "./ui";

export interface PolicyCardProps {
  payee: string;
  scope: Pick<Deliverable, "value_usd">[];
  start: string;
  end: string;
  repos: string[];
  approver?: string;
  status?: "draft" | "live" | "frozen" | "ended";
  agentId?: string | null;
}

/** The contract rendered as the platform policy it becomes. */
export function PolicyCard(p: PolicyCardProps) {
  const values = p.scope.map((d) => Number(d.value_usd) || 0);
  const total = values.reduce((a, b) => a + b, 0);
  const largest = values.length ? Math.max(...values) : 0;
  const rows: { icon: IconName; label: string; value: string }[] = [
    { icon: "user", label: "Pays only", value: p.payee || "—" },
    { icon: "zap", label: "One payment", value: largest ? `≤ ${usd(largest)}` : "—" },
    { icon: "coins", label: "Funded with", value: total ? `${usd(total)}, the scope` : "—" },
    { icon: "check", label: "Approves each", value: p.approver || "The company" },
    { icon: "calendar", label: "Can pay until", value: p.end ? dateText(p.end) : "—" },
  ];
  const status = p.status ?? "draft";
  return (
    <div className={`policy-card policy-${status}`}>
      <div className="policy-top">
        <div>
          <div className="policy-kicker">Contract agent</div>
          <div className="policy-id">{p.agentId ?? (status === "draft" ? "Not created yet" : "—")}</div>
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
            <Icon name="lock" size={13} className="policy-lock" />
          </li>
        ))}
      </ul>
      <div className="policy-foot">
        <span>
          <Icon name="shieldCheck" size={14} /> Enforced by the MultiAgency platform
        </span>
      </div>
      <div className="policy-app">
        <div className="policy-app-label">Judged by Covenant on every merge</div>
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
