import { useCallback } from "react";
import { api } from "../api";
import { Icon } from "../components/icons";
import { Alert, Avatar, Badge, Button, Empty, LinkButton, PageLoading, Progress, dateText, usd, type Tone } from "../components/ui";
import { AccountReadGate, useAccountResource } from "../useAccountResource";

import type { ContractRow as Row } from "../types";

export const STAGES: Record<string, { label: string; tone: Tone }> = {
  needs_signatures: { label: "Awaiting signatures", tone: "warning" },
  needs_setup: { label: "Setting up", tone: "info" },
  needs_create: { label: "Setting up", tone: "info" },
  needs_consent: { label: "Setting up", tone: "info" },
  needs_grant: { label: "Setting up", tone: "info" },
  needs_policy: { label: "Setting up", tone: "info" },
  policy_pending: { label: "Setting up", tone: "info" },
  needs_funding: { label: "Needs funding", tone: "warning" },
  active: { label: "Active", tone: "success" },
  ended: { label: "Ended", tone: "neutral" },
  frozen: { label: "Frozen", tone: "danger" },
};

export function Home() {
  const read = useCallback(() => api<Row[]>("GET", "/contracts?role=agency"), []);
  const resource = useAccountResource("contracts:agency", read);
  const rows = resource.value;
  if (!resource.enabled) return <AccountReadGate />;
  if (resource.error) return <div className="page stack"><Alert tone="danger">{resource.error}</Alert><Button variant="secondary" onClick={resource.reload}>Retry loading jobs</Button></div>;
  if (rows === null) return <PageLoading />;
  if (rows.length === 0) return <Welcome />;

  const active = rows.filter((r) => r.stage === "active");
  const committed = active.reduce((n, r) => n + Number(r.total), 0);
  const used = rows.reduce((n, r) => n + Number(r.paid), 0);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Agency work</h1>
          <p className="page-sub">Jobs where this account is the named agency representative. Review submissions and approve payouts here.</p>
        </div>
        <AgencyActions />
      </header>

      <div className="stats-row">
        <div className="stat">
          <div className="stat-label">Active jobs</div>
          <div className="stat-value">{active.length}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Agreed scope</div>
          <div className="stat-value">{usd(committed)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Recorded as paid</div>
          <div className="stat-value">{usd(used)}</div>
        </div>
      </div>

      <div className="card table-card">
        <table className="table agency-jobs">
          <thead>
            <tr>
              <th>Builder</th>
              <th>Scope</th>
              <th className="hide-sm">Recorded paid</th>
              <th className="hide-sm">Term</th>
              <th>Status</th>
              <th aria-label="Open" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => (window.location.hash = `/c/${r.id}`)} className="row-link">
                <td>
                  <div className="who">
                    <Avatar name={r.contractor} />
                    <div>
                      <a href={`#/c/${r.id}`} className="who-name">
                        {r.contractor}
                      </a>
                      <div className="who-sub">
                        {r.company} · {r.payee}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="num">{usd(r.total)}</td>
                <td className="hide-sm">
                  <div className="usage">
                    <Progress value={Number(r.paid)} max={Number(r.total)} label={`Recorded payment for ${r.contractor}`} />
                    <span className="num muted">{usd(r.paid)}</span>
                  </div>
                </td>
                <td className="hide-sm muted">
                  {dateText(r.start)} – {dateText(r.end)}
                </td>
                <td>
                  <Badge tone={STAGES[r.stage]?.tone ?? "neutral"} dot>
                    {STAGES[r.stage]?.label ?? r.stage}
                  </Badge>
                </td>
                <td className="chev">
                  <Icon name="chevronRight" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">Recorded paid totals include agency-reported arrivals. Open a job to distinguish those reports from platform-confirmed settlement.</p>
    </div>
  );
}

function AgencyActions() {
  return <div className="header-actions">
    <LinkButton href="#/new" variant="primary" icon="plus">New job</LinkButton>
    <LinkButton href="#/market" icon="bot">Market integration</LinkButton>
  </div>;
}

function Welcome() {
  return <div className="page stack">
    <header className="page-header">
      <div><h1>Agency work</h1><p className="page-sub">Jobs where this account is the named agency representative.</p></div>
      <AgencyActions />
    </header>
    <Empty icon="building" title="No agency jobs for this account yet" sub="Create a job to agree the scope and payment terms with a builder, then review their submissions and approve payouts." />
  </div>;
}
