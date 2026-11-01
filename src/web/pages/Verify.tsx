import { useEffect, useState } from "react";
import { api } from "../api";
import { Banner, Button, Card, GuidePanel, Json, KV, usdText, when } from "../components/ui";
import type { VerifyReport } from "../types";

export function VerifyPage({ id }: { id: string }) {
  const [v, setV] = useState<VerifyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<VerifyReport>("GET", `/contracts/${id}/verify`).then(setV, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, [id]);

  if (!v) return <div className="container">{error ? <Banner tone="bad">{error}</Banner> : <p className="muted">Checking…</p>}</div>;
  const t = v.terms;

  return (
    <div className="container wizard-layout">
      <div className="wizard-main">
        <p className="eyebrow">Verify · {t.company} → {t.contractor.name}</p>
        <h1>{v.overall === "green" ? "Your contract wallet matches what you signed." : v.overall === "incomplete" ? "This contract wallet isn't set up yet." : "Something doesn't match."}</h1>
        <Card title="Checks" actions={<Button kind="secondary" small onClick={load}>Re-check</Button>}>
          <ul className="checks big">
            {v.checks.map((c) => (
              <li key={c.id} className={c.ok ? "ok" : "bad"}>
                <span aria-hidden>{c.ok ? "✓" : "✗"}</span> {c.label}
              </li>
            ))}
          </ul>
          {v.frozen ? <Banner tone="bad">The representative froze this wallet. It can't pay anything.</Banner> : null}
        </Card>

        <Card title="What the provider reports">
          <KV
            rows={[
              ["Policy status", v.policy ? `${v.policy.status}${v.policy.synced ? ", synced" : ", not synced"}` : "—"],
              ["Policy hash", v.policy ? <code>{v.policy.policy_hash}</code> : "—"],
              ["Grant expires", v.grant ? when(v.grant.expires_at) : "—"],
              ["Contract ends", `${t.end} 23:59:59 UTC`],
              ["Balance", v.funds ? usdText(v.funds.available_usd) : "—"],
              ["Monthly cap", usdText(t.monthly_cap_usd)],
            ]}
          />
          {v.policy && v.policy.diffs.length ? (
            <>
              <h3 className="sub">Differences</h3>
              <table className="prs">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>From the signed terms</th>
                    <th>Live</th>
                  </tr>
                </thead>
                <tbody>
                  {v.policy.diffs.map((d) => (
                    <tr key={d.path}>
                      <td>
                        <code>{d.path}</code>
                      </td>
                      <td>
                        <code>{JSON.stringify(d.expected)}</code>
                      </td>
                      <td>
                        <code>{JSON.stringify(d.actual)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          <Json value={v.compiled.policy} label="Policy compiled from the signed terms" />
          <p className="hint">
            This compares what the NEAR Intents API reports with the policy compiled from the signed terms. It is a field-by-field check, not a
            cryptographic proof.
          </p>
        </Card>
        <p className="hint">
          <a href={`#/c/${id}`}>Back to the contract</a>
        </p>
      </div>
      <GuidePanel step="verify" />
    </div>
  );
}
