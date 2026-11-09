import { useCallback, useEffect, useState } from "react";
import { fromAtomic, toAtomic } from "../../shared/money";
import { api } from "../api";
import { Icon } from "../components/icons";
import { PolicyCard } from "../components/PolicyCard";
import { Alert, Button, Disclosure, Mono, PageLoading, short, timeText, usd } from "../components/ui";
import type { ContractView, VerifyView } from "../types";

const atomicUsd = (a: string | null | undefined) => (a ? usd(fromAtomic(BigInt(a), 6)) : "—");
/** Server check details carry raw atomic amounts and ISO times; show them as people read them. */
const detailText = (d: string) =>
  d.replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/g, (t) => timeText(t)).replace(/^\d{7,}$/, (a) => atomicUsd(a));
const list = (xs: string[] | "any" | undefined) => (xs === undefined ? "—" : xs === "any" ? "any" : xs.length ? xs.map((x) => (x.startsWith("nep141:") ? "USDC" : x)).join(", ") : "none");

/** The contractor's view: the live platform policy, read through Covenant, against what they signed. */
export function VerifyPage({ id }: { id: string }) {
  const [c, setC] = useState<ContractView | null>(null);
  const [v, setV] = useState<VerifyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [cv, vv] = await Promise.all([api<ContractView>("GET", `/contracts/${id}`), api<VerifyView>("GET", `/contracts/${id}/verify`)]);
      setC(cv);
      setV(vv);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!v || !c) return error ? <div className="narrow"><Alert tone="danger">{error}</Alert></div> : <PageLoading />;
  const t = c.terms;
  const ok = v.overall === "green";
  const matchChecks = v.checks.filter((x) => !x.info);
  const infoChecks = v.checks.filter((x) => x.info);
  const passed = matchChecks.filter((x) => x.ok).length;
  const e = v.expected;
  const o = v.observed?.policy ?? null;
  const usdc = e.asset;
  const payoutConsent = v.consents.find((x) => x.scopes.includes("payout") && !x.revoked);
  const paid = toAtomic(c.paid_usd, 6);
  const balance = v.observed ? BigInt(v.observed.usdc) : null;
  const within = balance === null ? null : paid + balance <= BigInt(e.total);

  const rows: { label: string; expected: string; observed: string; ok: boolean | null }[] = [
    { label: "Pays only", expected: e.withdrawals.join(", "), observed: list(o?.withdrawals), ok: o ? o.withdrawals.join(",") === e.withdrawals.join(",") : null },
    { label: "Asset", expected: "USDC", observed: list(o?.assets), ok: o ? Array.isArray(o.assets) && o.assets.length === 1 && o.assets[0] === usdc : null },
    { label: "Actions", expected: "withdraw", observed: o ? o.actions.join(", ") || "none" : "—", ok: o ? o.actions.join(",") === "withdraw" : null },
    { label: "One payment ≤", expected: atomicUsd(e.per_transaction), observed: atomicUsd(o?.limits.per_transaction?.[usdc]), ok: o ? o.limits.per_transaction?.[usdc] === e.per_transaction : null },
    { label: "Owner approval", expected: "every payout", observed: o ? (o.owner_approval ? "every payout" : "off") : "—", ok: o ? o.owner_approval : null },
    { label: "Frozen", expected: "no", observed: o ? (o.frozen ? "yes" : "no") : "—", ok: o ? !o.frozen : null },
    {
      label: "Payout consent ends",
      expected: `by ${timeText(e.payout_consent_expires_by)}`,
      observed: payoutConsent ? timeText(payoutConsent.expiresAt) : "—",
      ok: payoutConsent ? Date.parse(payoutConsent.expiresAt) <= Date.parse(e.payout_consent_expires_by) : null,
    },
  ];

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
            {matchChecks.map((x) => (
              <li key={x.id} className={x.ok ? "ok" : "bad"} title={x.detail}>
                <Icon name={x.ok ? "check" : "x"} size={15} strokeWidth={2.4} />
                <span>
                  {x.label}
                  {x.detail ? <span className="check-detail">{detailText(x.detail)}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          {o?.frozen ? <Alert tone="danger" icon="snowflake">The company froze this contract's agent.</Alert> : null}

          <Disclosure label="Signed vs. live policy">
            <table className="table compact compare">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Signed</th>
                  <th>Live</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    <td>{r.expected}</td>
                    <td className={r.ok === null ? "" : r.ok ? "ok" : "bad"}>{r.observed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Disclosure>

          <ul className="info-rows">
            <li>
              <Icon name="coins" size={14} />
              <span>
                Paid {usd(c.paid_usd)} + balance {balance === null ? "—" : atomicUsd(balance.toString())} {within === false ? ">" : "≤"} total {atomicUsd(e.total)}.
                {" "}The funded total is what caps the contract.
              </span>
            </li>
            <li>
              <Icon name="info" size={14} />
              <span>
                Daily {atomicUsd(o?.limits.daily?.[usdc])} and monthly {atomicUsd(o?.limits.monthly?.[usdc])} limits are set too. Monthly and daily are not what caps the contract: they reset.
              </span>
            </li>
            {infoChecks
              .filter((x) => !["funded", "windows", "relay"].includes(x.id))
              .map((x) => (
                <li key={x.id}>
                  <Icon name="info" size={14} />
                  <span>
                    {x.label}
                    {x.detail ? ` · ${detailText(x.detail)}` : ""}
                  </span>
                </li>
              ))}
          </ul>

          <Disclosure label="Details">
            <div className="kv-line">
              <span>Policy</span>
              <span>{v.observed ? `${v.observed.status}${v.observed.synced ? " · synced" : ""} · revision ${v.observed.revision ?? "—"}` : "—"}</span>
            </div>
            <div className="kv-line">
              <span>Policy digest</span>
              {v.observed?.digest ? <Mono copy={v.observed.digest}>{short(v.observed.digest, 10, 6)}</Mono> : <span>—</span>}
            </div>
            {v.observed?.grants.map((g) => (
              <div className="kv-line" key={g.label + g.expiresAt}>
                <span>Grant {g.label}</span>
                <span>{g.revoked ? "revoked" : `expires ${timeText(g.expiresAt)} (platform-chosen)`}</span>
              </div>
            ))}
            {v.consents.map((x) => (
              <div className="kv-line" key={x.id}>
                <span>Consent {x.scopes.join(", ")}</span>
                <span>{x.revoked ? "revoked" : `until ${timeText(x.expiresAt)}`}</span>
              </div>
            ))}
            <div className="kv-line">
              <span>Terms hash</span>
              <Mono copy={c.hash}>{short(c.hash, 10, 6)}</Mono>
            </div>
          </Disclosure>
          <p className="fineprint">Covenant relays the platform's read of this contract's agent; it compares it with the policy the signed terms call for.</p>
        </div>
        <PolicyCard
          payee={t.payee.address}
          scope={t.scope}
          start={t.start}
          end={t.end}
          repos={t.repos}
          approver={t.representative.near_account}
          status={o?.frozen ? "frozen" : v.observed ? "live" : "draft"}
          agentId={v.observed?.agentId ?? c.platform.agent_id}
        />
      </div>
    </div>
  );
}
