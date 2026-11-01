import { useEffect, useState } from "react";
import { api } from "../api";
import { Pill, usdText } from "../components/ui";

interface Row {
  id: string;
  company: string;
  contractor: string;
  cap: string;
  end: string;
  stage: string;
}

const STAGE: Record<string, { label: string; tone: "ok" | "warn" | "info" | "muted" | "bad" }> = {
  needs_signatures: { label: "Waiting for signatures", tone: "warn" },
  needs_wallet: { label: "Needs its wallet", tone: "warn" },
  needs_grant: { label: "Needs agent permission", tone: "warn" },
  needs_funding: { label: "Needs funding", tone: "warn" },
  active: { label: "Active", tone: "ok" },
  ended: { label: "Ended", tone: "muted" },
  frozen: { label: "Frozen", tone: "bad" },
};

export function Home() {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    api<Row[]>("GET", "/contracts").then(setRows, () => setRows([]));
  }, []);

  return (
    <div className="container">
      <section className="hero">
        <p className="eyebrow">Contractor payroll on NEAR</p>
        <h1>The contract is the spending limit.</h1>
        <p className="lede">
          Each signed work order becomes its own NEAR Intents agent wallet. The payee, the monthly cap and the end date come from the contract, and
          the provider enforces them. An AI agent pays for accepted work on its own, and neither it nor our server can overpay, pay someone else, or
          pay after the contract ends.
        </p>
        <div className="hero-actions">
          <a className="btn btn-primary" href="#/new">
            Start the wizard
          </a>
          <a className="btn btn-secondary" href="#/guide">
            Read the guide
          </a>
        </div>
      </section>

      <section className="how">
        {[
          ["1", "Both sign", "Company and contractor sign the terms hash with their NEAR wallets."],
          ["2", "One wallet per contract", "The terms compile into the wallet's policy: only the payee, only up to the cap."],
          ["3", "The agent pays", "It reviews merged PRs, decides, and pays inside the limits. You can cancel during the timelock."],
          ["4", "Anyone verifies", "The contractor checks the live wallet against what they signed."],
        ].map(([n, t, d]) => (
          <div className="how-item" key={n}>
            <span className="how-n">{n}</span>
            <h3>{t}</h3>
            <p>{d}</p>
          </div>
        ))}
      </section>

      <section>
        <h2 className="section-title">Contracts</h2>
        {rows === null ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="empty">
            <p>No contracts yet.</p>
            <a className="btn btn-primary" href="#/new">
              Draft the first one
            </a>
          </div>
        ) : (
          <ul className="list">
            {rows.map((r) => (
              <li key={r.id}>
                <a href={`#/c/${r.id}`}>
                  <div>
                    <strong>
                      {r.company} → {r.contractor}
                    </strong>
                    <span className="muted">
                      {" "}
                      · up to {usdText(r.cap)}/month · ends {r.end}
                    </span>
                  </div>
                  <Pill tone={STAGE[r.stage]?.tone ?? "muted"}>{STAGE[r.stage]?.label ?? r.stage}</Pill>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
