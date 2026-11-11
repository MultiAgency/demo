import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/icons";
import { PolicyCard } from "../components/PolicyCard";
import { Avatar, Badge, LinkButton, PageLoading, Progress, dateText, usd, type Tone } from "../components/ui";

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
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    api<Row[]>("GET", "/contracts").then(setRows, () => setRows([]));
  }, []);

  if (rows === null) return <PageLoading />;
  if (rows.length === 0) return <Welcome />;

  const active = rows.filter((r) => r.stage === "active");
  const committed = active.reduce((n, r) => n + Number(r.total), 0);
  const used = rows.reduce((n, r) => n + Number(r.paid), 0);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Contracts</h1>
          <p className="page-sub">Each contract has its own platform agent and limits.</p>
        </div>
        <LinkButton href="#/new" variant="primary" icon="plus">
          New contract
        </LinkButton>
      </header>

      <div className="stats-row">
        <div className="stat">
          <div className="stat-label">Active contracts</div>
          <div className="stat-value">{active.length}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Scope under contract</div>
          <div className="stat-value">{usd(committed)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Paid for merged work</div>
          <div className="stat-value">{usd(used)}</div>
        </div>
      </div>

      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Contractor</th>
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
          <Badge tone="accent">Pay-on-merge, judged against the scope</Badge>
          <h1 className="display">The contract is the spending limit.</h1>
          <p className="lede">Sign a scope. Every merged PR is judged against it, and you approve each payout. The platform enforces the most it can ever be.</p>
          <div className="row gap">
            <LinkButton href="#/new" variant="primary" icon="plus">
              Create a contract
            </LinkButton>
            <LinkButton href="#/guide" variant="ghost" icon="book">
              How it works
            </LinkButton>
          </div>
        </div>
        <div className="welcome-visual">
          <PolicyCard payee="maria.near" scope={[{ value_usd: "1200" }, { value_usd: "500" }, { value_usd: "300" }]} start="2026-11-01" end="2026-12-31" repos={["acme/app"]} approver="acme.near" status="live" agentId="agent · Acme → Maria" />
        </div>
      </section>

      <section className="features">
        {(
          [
            ["pen", "Sign a scope", "Deliverables with a value each, signed by both sides."],
            ["wallet", "Fund its own agent", "The scope becomes the agent's policy and balance."],
            ["bot", "Approve on merge", "A judge decides how much each merge completes; you approve the payout."],
            ["shieldCheck", "Anyone can verify", "The live policy, checked against what was signed."],
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
