import { Icon, type IconName } from "./icons";
import { dateText, usd } from "./ui";

export interface PolicyCardProps {
  payee: string;
  cap: string;
  rate: string;
  start: string;
  end: string;
  repos: string[];
  timelockMinutes: number;
  status?: "draft" | "live" | "frozen" | "ended";
  agentId?: string | null;
}

/** The contract rendered as the wallet it compiles to. */
export function PolicyCard(p: PolicyCardProps) {
  const rows: { icon: IconName; label: string; value: string }[] = [
    { icon: "user", label: "Pays only", value: p.payee || "—" },
    { icon: "coins", label: "Up to", value: p.cap ? `${usd(p.cap)} / month` : "—" },
    { icon: "calendar", label: "Valid until", value: p.end ? dateText(p.end) : "—" },
    { icon: "clock", label: "Cancel window", value: `${p.timelockMinutes} min` },
  ];
  const status = p.status ?? "draft";
  return (
    <div className={`policy-card policy-${status}`}>
      <div className="policy-top">
        <div>
          <div className="policy-kicker">Contract wallet</div>
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
          <Icon name="shieldCheck" size={14} /> Enforced by NEAR Intents
        </span>
      </div>
      <div className="policy-app">
        <div className="policy-app-label">Checked by Covenant before paying</div>
        <div className="policy-app-row">
          <Icon name="pr" size={14} />
          {p.rate ? `${usd(p.rate)} per merged PR` : "—"}
          <span className="sep">·</span>
          {p.repos.filter(Boolean).join(", ") || "—"}
          <span className="sep">·</span>
          from {p.start ? dateText(p.start) : "—"}
        </div>
      </div>
    </div>
  );
}
