import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/icons";
import { PolicyCard } from "../components/PolicyCard";
import { Alert, Button, Disclosure, Mono, PageLoading, short, timeText, usd } from "../components/ui";
import type { VerifyReport } from "../types";

export function VerifyPage({ id }: { id: string }) {
  const [v, setV] = useState<VerifyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<VerifyReport>("GET", `/contracts/${id}/verify`).then(setV, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, [id]);

  if (!v) return error ? <div className="narrow"><Alert tone="danger">{error}</Alert></div> : <PageLoading />;
  const t = v.terms;
  const ok = v.overall === "green";
  const matchChecks = v.checks.filter((c) => !c.info);
  const passed = matchChecks.filter((c) => c.ok).length;

  return (
    <div className="narrow wide">
      <div className={`verdict verdict-${v.overall}`}>
        <span className="verdict-icon">
          <Icon name={ok ? "shieldCheck" : v.overall === "incomplete" ? "clock" : "shieldX"} size={28} />
        </span>
        <div>
          <h1>{ok ? "Matches what you signed" : v.overall === "incomplete" ? "Not set up yet" : "Something doesn't match"}</h1>
          <p>
            {t.company} → {t.contractor.name} · {passed} of {matchChecks.length} checks passed
          </p>
        </div>
        <Button variant="secondary" size="sm" icon="activity" onClick={load}>
          Re-check
        </Button>
      </div>

      <div className="split even">
        <div className="card card-pad">
          <ul className="checks big">
            {v.checks.map((c) => (
              <li key={c.id} className={c.ok ? "ok" : c.info ? "warn" : "bad"}>
                <Icon name={c.ok ? "check" : c.info ? "alert" : "x"} size={15} strokeWidth={2.4} />
                {c.label}
              </li>
            ))}
          </ul>
          {v.frozen ? <Alert tone="danger" icon="snowflake">The company froze this wallet.</Alert> : null}
          {v.policy?.diffs.length ? (
            <Disclosure label={`${v.policy.diffs.length} difference(s)`}>
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Signed</th>
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
            </Disclosure>
          ) : null}
          <Disclosure label="Details">
            <div className="kv-line">
              <span>Policy</span>
              <span>{v.policy ? `${v.policy.status}${v.policy.synced ? " · synced" : ""}` : "—"}</span>
            </div>
            <div className="kv-line">
              <span>Policy hash</span>
              {v.policy ? <Mono copy={v.policy.policy_hash}>{short(v.policy.policy_hash, 10, 6)}</Mono> : <span>—</span>}
            </div>
            <div className="kv-line">
              <span>Permission expires</span>
              <span>{v.grant ? timeText(v.grant.expires_at) : "—"}</span>
            </div>
            <div className="kv-line">
              <span>Balance</span>
              <span>{v.funds ? usd(v.funds.available_usd) : "—"}</span>
            </div>
            <div className="kv-line">
              <span>Terms hash</span>
              <Mono copy={v.hash}>{short(v.hash, 10, 6)}</Mono>
            </div>
          </Disclosure>
          <p className="fineprint">Compares what the NEAR Intents API reports with the policy compiled from the signed terms.</p>
        </div>
        <PolicyCard
          payee={t.payee.address}
          scope={t.scope}
          start={t.start}
          end={t.end}
          repos={t.repos}
          timelockMinutes={Math.round(v.compiled.policy.timelock_ms / 60000)}
          status={v.frozen ? "frozen" : v.policy ? "live" : "draft"}
          agentId={v.agent_id}
        />
      </div>
    </div>
  );
}
