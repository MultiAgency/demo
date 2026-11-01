import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/icons";
import { PolicyCard } from "../components/PolicyCard";
import { Avatar, Badge, LinkButton, PageLoading, Progress, dateText, usd, type Tone } from "../components/ui";

interface Row {
  id: string;
  company: string;
  contractor: string;
  payee: string;
  cap: string;
  used: string;
  start: string;
  end: string;
  stage: string;
}

export const STAGES: Record<string, { label: string; tone: Tone }> = {
  needs_signatures: { label: "Awaiting signatures", tone: "warning" },
  needs_wallet: { label: "Setting up", tone: "info" },
  needs_grant: { label: "Setting up", tone: "info" },
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
  const committed = active.reduce((n, r) => n + Number(r.cap), 0);
  const used = active.reduce((n, r) => n + Number(r.used), 0);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Contracts</h1>
          <p className="page-sub">Each contract has its own wallet and limits.</p>
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
          <div className="stat-label">Monthly limit, all contracts</div>
          <div className="stat-value">{usd(committed)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Paid or queued this month</div>
          <div className="stat-value">{usd(used)}</div>
        </div>
      </div>

      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Contractor</th>
              <th>Monthly limit</th>
              <th className="hide-sm">Used this month</th>
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
                <td className="num">{usd(r.cap)}</td>
                <td className="hide-sm">
                  <div className="usage">
                    <Progress value={Number(r.used)} max={Number(r.cap)} />
                    <span className="num muted">{usd(r.used)}</span>
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
          <Badge tone="accent">Contractor payroll on NEAR</Badge>
          <h1 className="display">The contract is the spending limit.</h1>
          <p className="lede">Every signed work order gets its own wallet. NEAR enforces who it pays, how much, and until when.</p>
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
          <PolicyCard payee="maria.near" cap="2000" rate="100" start="2026-11-01" end="2026-12-31" repos={["acme/app"]} timelockMinutes={10} status="live" agentId="agent · Acme → Maria" />
        </div>
      </section>

      <section className="features">
        {(
          [
            ["pen", "Both parties sign", "Company and contractor sign the same terms hash."],
            ["wallet", "One wallet per contract", "The terms become the wallet's policy."],
            ["bot", "An agent pays", "It reviews merged PRs and pays inside the limits."],
            ["shieldCheck", "Anyone can verify", "The live wallet, checked against what was signed."],
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
