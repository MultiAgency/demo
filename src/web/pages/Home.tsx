import { useCallback } from "react";
import { api } from "../api";
import { Icon } from "../components/icons";
import { PolicyCard } from "../components/PolicyCard";
import { Alert, Avatar, Badge, Button, LinkButton, PageLoading, Progress, dateText, usd, type Tone } from "../components/ui";
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
  const read = useCallback(() => api<Row[]>("GET", "/contracts"), []);
  const resource = useAccountResource("contracts", read);
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
          <h1>Jobs</h1>
          <p className="page-sub">Each job has its own platform agent and agreed limits.</p>
        </div>
        <LinkButton href="#/new" variant="primary" icon="plus">
          New job
        </LinkButton>
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
          <div className="stat-label">Paid to builders</div>
          <div className="stat-value">{usd(used)}</div>
        </div>
      </div>

      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Builder</th>
              <th>Scope</th>
              <th className="hide-sm">Paid</th>
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
                    <Progress value={Number(r.paid)} max={Number(r.total)} />
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
    </div>
  );
}

function Welcome() {
  return (
    <div className="page">
      <section className="welcome">
        <div className="welcome-copy">
          <Badge tone="accent">Agreed scope. Explicit payout approval.</Badge>
          <h1 className="display">Agree the work. Approve the payment.</h1>
          <p className="lede">Sign the scope, budget and payment terms. The builder submits a report and invoice, an agent proposes compensation, and you approve each payout before settlement.</p>
          <div className="row gap">
            <LinkButton href="#/new" variant="primary" icon="plus">
              Create a job
            </LinkButton>
            <LinkButton href="#/guide" variant="ghost" icon="book">
              How it works
            </LinkButton>
          </div>
        </div>
        <div className="welcome-visual">
          <PolicyCard payee="maria.near" scope={[{ value_usd: "1200" }, { value_usd: "500" }, { value_usd: "300" }]} start="2026-11-01" end="2026-12-31" repos={["acme/app"]} approver="acme.near" status="live" agentId="agent · Acme → Maria" reportWorkflow />
        </div>
      </section>

      <section className="features">
        {(
          [
            ["pen", "Agree the terms", "Scope, acceptance criteria and payment terms, signed by both sides."],
            ["wallet", "Fund its own agent", "The scope becomes the agent's policy and balance."],
            ["bot", "Review the work", "Report and invoice is the default. Pay on merge remains available for code work."],
            ["shieldCheck", "Confirm payment", "Both parties see payment status and the policy checked against the signed terms."],
          ] as const
        ).map(([icon, t, d]) => (
          <div className="feature" key={t}>
            <span className="icon-tile">
              <Icon name={icon} />
            </span>
            <h3>{t}</h3>
            <p>{d}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
