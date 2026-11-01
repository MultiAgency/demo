import { useCallback, useEffect, useMemo, useState } from "react";
import { api, links, ownerAction, signMessage } from "../api";
import { Banner, Button, Card, ErrorText, GuidePanel, Json, KV, Pill, shortHash, usdText, when } from "../components/ui";
import { STEPS, type StepId } from "../guide";
import type { AppConfig, AttackResult, ContractView, Payout, VerifyReport } from "../types";

interface Props {
  id: string;
  config: AppConfig;
}

export function ContractPage({ id, config }: Props) {
  const [c, setC] = useState<ContractView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyReport | null>(null);
  const [attacks, setAttacks] = useState<Record<string, AttackResult>>({});
  const [step, setStep] = useState<StepId | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api<ContractView>("GET", `/contracts/${id}`);
      setC(next);
      if (next.grant) setVerify(await api<VerifyReport>("GET", `/contracts/${id}/verify`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while a payout waits out its timelock.
  useEffect(() => {
    if (!c?.payouts.some((p) => p.status === "queued")) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [c, load]);

  const done = useMemo(() => {
    const d: Partial<Record<StepId, boolean>> = { draft: true };
    if (!c) return d;
    d["rep-sign"] = !!c.signatures.representative;
    d["contractor-sign"] = !!c.signatures.contractor;
    d.wallet = !!c.agent;
    d.grant = !!c.grant;
    d.fund = !!c.agent && (Number(c.agent.available_usd) > 0 || c.payouts.length > 0);
    d.pay = c.payouts.some((p) => p.status === "paid");
    d.verify = verify?.overall === "green" || (d.pay && verify?.checks.filter((x) => x.id !== "funded").every((x) => x.ok));
    d.attack = Object.values(attacks).some((a) => a.outcome);
    return d;
  }, [c, verify, attacks]);

  const current: StepId = STEPS.find((s) => !done[s.id])?.id ?? "attack";
  const active = step ?? current;

  if (!c) return <div className="container">{error ? <Banner tone="bad">{error}</Banner> : <p className="muted">Loading…</p>}</div>;

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
      setStep(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="container">
      <header className="contract-head">
        <div>
          <p className="eyebrow">Contract {c.id}</p>
          <h1>
            {c.terms.company} → {c.terms.contractor.name}
          </h1>
          <p className="muted">
            {usdText(c.terms.rate_per_accepted_pr_usd)} per accepted PR · cap {usdText(c.terms.monthly_cap_usd)}/month · {c.terms.start} → {c.terms.end} · terms{" "}
            <code title={c.hash}>{shortHash(c.hash)}</code>
          </p>
        </div>
        <StagePill stage={c.stage} />
      </header>

      {config.provider === "sim" ? <SimControls c={c} config={config} onChange={load} /> : null}

      <div className="wizard-layout three">
        <nav className="stepper" aria-label="Steps">
          <ol>
            {STEPS.map((s) => (
              <li key={s.id}>
                <button className={`step${active === s.id ? " is-active" : ""}${done[s.id] ? " is-done" : ""}`} onClick={() => setStep(s.id)}>
                  <span className="step-n">{done[s.id] ? "✓" : s.n}</span>
                  <span className="step-t">{s.title}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <div className="wizard-main">
          <ErrorText error={error} />
          <StepBody step={active} c={c} config={config} verify={verify} attacks={attacks} setAttacks={setAttacks} act={act} reload={load} />
          {active !== current && !done[active] ? (
            <p className="hint">
              This step comes later. <button className="link" onClick={() => setStep(null)}>Go to the current step</button>
            </p>
          ) : null}
          <Activity events={c.events} />
        </div>

        <GuidePanel step={active} />
      </div>
    </div>
  );
}

function StagePill({ stage }: { stage: ContractView["stage"] }) {
  const map: Record<ContractView["stage"], [string, "ok" | "warn" | "bad" | "muted"]> = {
    needs_signatures: ["Waiting for signatures", "warn"],
    needs_wallet: ["Needs its wallet", "warn"],
    needs_grant: ["Needs agent permission", "warn"],
    needs_funding: ["Needs funding", "warn"],
    active: ["Active", "ok"],
    ended: ["Ended", "muted"],
    frozen: ["Frozen", "bad"],
  };
  const [label, tone] = map[stage];
  return <Pill tone={tone}>{label}</Pill>;
}

interface BodyProps {
  step: StepId;
  c: ContractView;
  config: AppConfig;
  verify: VerifyReport | null;
  attacks: Record<string, AttackResult>;
  setAttacks: (fn: (a: Record<string, AttackResult>) => Record<string, AttackResult>) => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  reload: () => Promise<void>;
}

function StepBody(p: BodyProps) {
  switch (p.step) {
    case "draft":
      return <DraftStep {...p} />;
    case "rep-sign":
      return <SignStep {...p} role="representative" />;
    case "contractor-sign":
      return <SignStep {...p} role="contractor" />;
    case "wallet":
      return <WalletStep {...p} />;
    case "grant":
      return <GrantStep {...p} />;
    case "fund":
      return <FundStep {...p} />;
    case "pay":
      return <PayStep {...p} />;
    case "verify":
      return <VerifyStep {...p} />;
    case "attack":
      return <AttackStep {...p} />;
  }
}

function TermsSummary({ c }: { c: ContractView }) {
  const t = c.terms;
  return (
    <KV
      rows={[
        ["Payee", <code>{t.payee.address}</code>],
        ["Monthly cap", usdText(t.monthly_cap_usd)],
        ["Rate", `${usdText(t.rate_per_accepted_pr_usd)} per accepted pull request`],
        ["Term", `${t.start} → ${t.end} (inclusive, UTC)`],
        ["Repositories", t.repos.join(", ")],
        ["Scope", t.scope],
        ["Representative", <code>{t.representative.near_account}</code>],
        ["Contractor", <>{t.contractor.name} · <code>{t.contractor.near_account}</code> · GitHub @{t.contractor.github}</>],
      ]}
    />
  );
}

function DraftStep({ c }: BodyProps) {
  return (
    <Card title="Draft created">
      <TermsSummary c={c} />
      <p className="hint">
        Terms hash <code>{c.hash}</code>. This is what both parties sign. Any change to the terms means a new draft.
      </p>
    </Card>
  );
}

function SignStep({ c, config, act, role }: BodyProps & { role: "representative" | "contractor" }) {
  const signed = c.signatures[role];
  const account = role === "representative" ? c.terms.representative.near_account : c.terms.contractor.near_account;
  const token = links.get(c.id);
  const contractorLink = token ? `${window.location.origin}/#/c/${c.id}/sign?t=${token}` : null;

  const sign = () =>
    act(async () => {
      const req = await api("GET", `/contracts/${c.id}/signing-request?role=${role}`);
      const s = await signMessage(config.provider, req);
      await api("POST", `/contracts/${c.id}/signatures`, { role, signed: s, contractor_token: token });
    });

  if (signed)
    return (
      <Card title={`${role === "representative" ? "Representative" : "Contractor"} signed`}>
        <KV rows={[["Account", <code>{signed.account_id}</code>], ["Key", <code>{shortHash(signed.public_key, 14)}</code>], ["Signed", when(signed.signed_at)]]} />
        <Banner tone="ok">Signature verified against a full-access key of {signed.account_id}.</Banner>
      </Card>
    );

  return (
    <Card title={role === "representative" ? "Sign as the representative" : "Get the contractor's signature"}>
      <p>
        {account} signs this message with their NEAR wallet (NEP-413, no gas):
      </p>
      <pre className="message">Covenant work order sha256:{c.hash}</pre>
      {role === "contractor" ? (
        contractorLink ? (
          <>
            <p>Send the contractor their private signing link. They see the terms in plain language and sign with their own wallet.</p>
            <div className="copy-row">
              <input readOnly value={contractorLink} onFocus={(e) => e.currentTarget.select()} aria-label="Contractor signing link" />
              <Button kind="secondary" small onClick={() => navigator.clipboard?.writeText(contractorLink)}>
                Copy
              </Button>
              <a className="btn btn-secondary btn-small" href={`#/c/${c.id}/sign?t=${token}`}>
                Open as contractor
              </a>
            </div>
          </>
        ) : (
          <Banner tone="warn">This browser doesn't have the contractor link. It is shown only to whoever created the draft.</Banner>
        )
      ) : null}
      <div className="form-actions">
        {role === "representative" || (config.provider === "sim" && token) ? (
          <Button onClick={sign}>
            {config.provider === "sim" ? `Sign as ${account} (demo wallet)` : `Sign with wallet as ${account}`}
          </Button>
        ) : null}
      </div>
      {role === "contractor" && config.provider === "sim" ? <p className="hint">Demo shortcut: the button above signs as the contractor from here.</p> : null}
    </Card>
  );
}

function PolicyPreview({ c }: { c: ContractView }) {
  const p = c.compiled.policy;
  const cap = p.limits.monthly?.[c.terms.asset];
  return (
    <>
      <ul className="clauses">
        <li>
          <strong>Payee clause</strong> → destinations: <em>only</em> <code>{p.destinations.list.map((d) => d.address).join(", ")}</code> on NEAR
        </li>
        <li>
          <strong>Cap clause</strong> → per payment and per month at most {cap ? `${Number(cap) / 1e6} USDC` : "—"}; USD budget backstop {usdText(p.budget.monthly_usd ?? "0")}
        </li>
        <li>
          <strong>Payment clause</strong> → actions: {p.actions.join(", ")}; assets: USDC only; owner approval {p.owner_approval ? "on" : "off"}
        </li>
        <li>
          <strong>Cancel window</strong> → timelock {Math.round(p.timelock_ms / 60000)} minutes; at most {p.max_actions_per_hour} payouts per hour
        </li>
        <li>
          <strong>Term clause</strong> → grant expires {when(c.compiled.grant.expires_at)}
        </li>
      </ul>
      <Json value={c.compiled} label="Show the compiled policy (JSON)" />
    </>
  );
}

function WalletStep({ c, config, act }: BodyProps) {
  if (c.agent)
    return (
      <Card title="Contract wallet created">
        <KV rows={[["Agent", <code>{c.agent.agent_id}</code>], ["Name", c.compiled.name], ["Frozen", c.agent.frozen ? "yes" : "no"]]} />
        <PolicyPreview c={c} />
      </Card>
    );
  const ready = !!c.signatures.representative && !!c.signatures.contractor;
  return (
    <Card title="Create this contract's wallet">
      <p>These signed terms compile into the policy below. The representative's wallet signs agent_create; Covenant never holds the owner key.</p>
      <PolicyPreview c={c} />
      {!ready ? <Banner tone="warn">Both parties must sign first.</Banner> : null}
      <div className="form-actions">
        <Button disabled={!ready} onClick={() => act(() => ownerAction(config.provider, c.id, "agent_create"))}>
          {config.provider === "sim" ? `Sign agent_create as ${c.terms.representative.near_account} (demo wallet)` : "Sign agent_create with wallet"}
        </Button>
      </div>
    </Card>
  );
}

function GrantStep({ c, config, act }: BodyProps) {
  if (c.grant)
    return (
      <Card title="Agent permission issued">
        <KV rows={[["Grant", <code>{c.grant.grant_id}</code>], ["Expires", when(c.grant.expires_at)], ["Contract end", `${c.terms.end} 23:59:59 UTC`]]} />
        <Banner tone="ok">The grant expires exactly at the contract end. After that, the provider refuses every payout request from the agent.</Banner>
      </Card>
    );
  return (
    <Card title="Give the agent its permission">
      <p>
        The grant is the agent's only credential. Its expiry is set to the contract end: <strong>{when(c.compiled.grant.expires_at)}</strong>.
      </p>
      <div className="form-actions">
        <Button disabled={!c.agent} onClick={() => act(() => ownerAction(config.provider, c.id, "grant_issue"))}>
          {config.provider === "sim" ? "Sign grant_issue (demo wallet)" : "Sign grant_issue with wallet"}
        </Button>
      </div>
    </Card>
  );
}

function FundStep({ c, config, act }: BodyProps) {
  const [amount, setAmount] = useState("60");
  if (!c.agent) return <Card title="Fund the wallet"><Banner tone="warn">Create the wallet first.</Banner></Card>;
  return (
    <Card title="Fund the wallet">
      <KV rows={[["Balance", usdText(c.agent.available_usd)], ["Monthly cap", usdText(c.terms.monthly_cap_usd)], ["Deposit address", <code>{c.agent.deposit_address}</code>]]} />
      {config.provider === "sim" ? (
        <div className="inline-form">
          <label>
            Amount (USDC)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </label>
          <Button onClick={() => act(() => api("POST", "/sim/fund", { agent_id: c.agent!.agent_id, usd: amount }))}>Deposit (simulated)</Button>
        </div>
      ) : (
        <p>Send USDC on NEAR to the deposit address above, then refresh.</p>
      )}
    </Card>
  );
}

function PayoutRow({ p, c, config, act }: { p: Payout } & Pick<BodyProps, "c" | "config" | "act">) {
  const tone = { paid: "ok", queued: "info", escalated: "warn", persisted: "info", cancelled: "muted", rejected: "muted", refused: "bad", failed: "bad", needs_review: "bad" } as const;
  return (
    <div className="payout">
      <div className="payout-head">
        <strong>{usdText(p.amount_usd)}</strong> <Pill tone={tone[p.status]}>{p.status.replace("_", " ")}</Pill>
        <span className="muted"> · {p.period} · {p.score.summary}</span>
      </div>
      <table className="prs">
        <tbody>
          {p.score.prs.map((pr) => (
            <tr key={pr.key}>
              <td>{pr.accepted ? "✓" : pr.flags.length ? "⚠" : "✗"}</td>
              <td>
                <a href={pr.url} target="_blank" rel="noreferrer">
                  {pr.key}
                </a>{" "}
                {pr.title}
              </td>
              <td className="muted">{pr.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.status === "queued" ? (
        <div className="payout-actions">
          <span>Dispatches {when(p.dispatch_at)} unless cancelled.</span>
          <Button kind="danger" small onClick={() => act(() => ownerAction(config.provider, c.id, "execution_cancel", p.id))}>
            Cancel payout
          </Button>
        </div>
      ) : null}
      {p.status === "escalated" ? (
        <div className="payout-actions">
          <span>The agent escalated instead of paying. Flagged PRs stay excluded if you approve.</span>
          <Button small onClick={() => act(() => api("POST", `/payouts/${p.id}/approve`))}>
            Approve {usdText(p.amount_usd)}
          </Button>
          <Button kind="secondary" small onClick={() => act(() => api("POST", `/payouts/${p.id}/reject`))}>
            Reject
          </Button>
        </div>
      ) : null}
      {p.tx_hash ? (
        <p className="hint">
          Tx <code>{p.tx_hash}</code>
        </p>
      ) : null}
      {p.error ? <Json value={p.error} label="Provider response" /> : null}
    </div>
  );
}

function PayStep(p: BodyProps) {
  const { c, act } = p;
  const ready = c.stage === "active";
  return (
    <Card title="The agent pays">
      <KV rows={[["Pay period", `${c.period.month} (${c.period.since.slice(0, 10)} → ${c.period.until.slice(0, 10)})`], ["Left under the cap", usdText(c.remaining_cap_usd)], ["Evidence", p.config.evidence === "fake" ? "seeded demo pull requests" : "GitHub"]]} />
      <div className="form-actions">
        <Button disabled={!ready} onClick={() => act(() => api("POST", `/contracts/${c.id}/run`))}>
          Run the agent now
        </Button>
      </div>
      {!ready ? <Banner tone="warn">The wallet must be created, granted and funded, and the contract active.</Banner> : null}
      {c.payouts.length ? <h3 className="sub">Payouts</h3> : null}
      {c.payouts.map((po) => (
        <PayoutRow key={po.id} p={po} c={c} config={p.config} act={act} />
      ))}
    </Card>
  );
}

function VerifyStep({ c, verify }: BodyProps) {
  return (
    <Card title="Contractor verifies" actions={<a className="btn btn-secondary btn-small" href={`#/c/${c.id}/verify`}>Open the Verify page</a>}>
      {!verify ? (
        <Banner tone="warn">Verification starts once the wallet exists and has its grant.</Banner>
      ) : (
        <ul className="checks">
          {verify.checks.map((ch) => (
            <li key={ch.id} className={ch.ok ? "ok" : "bad"}>
              <span aria-hidden>{ch.ok ? "✓" : "✗"}</span> {ch.label}
            </li>
          ))}
        </ul>
      )}
      <p className="hint">Share the Verify page with the contractor. It needs no wallet and no login.</p>
    </Card>
  );
}

const SCENARIOS: { id: string; title: string; text: string }[] = [
  { id: "overpay", title: "Overpay", text: "Pay $1 more than the monthly cap." },
  { id: "redirect", title: "Redirect", text: "Send $1 to attacker.near instead of the payee." },
  { id: "injected", title: "Prompt-injected PR", text: "A PR tells the AI reviewer to pay $5,000. Suppose it works." },
  { id: "after_end", title: "After the end date", text: "Pay $1 after the contract has ended." },
];

function AttackStep({ c, config, attacks, setAttacks, reload }: BodyProps) {
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const run = async (id: string) => {
    setError(null);
    try {
      const r = await api<AttackResult>("POST", `/contracts/${c.id}/attacks/${id}?mode=${live ? "live" : "dry"}`);
      setAttacks((a) => ({ ...a, [id]: r }));
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card title="Compromised server: try to break it">
      <p>
        App-side checks are <strong>off</strong>. Each request goes straight to NEAR Intents with this contract's real grant.
      </p>
      {config.provider === "sim" ? (
        <label className="toggle">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Send for real (simulated provider), not a dry run
        </label>
      ) : null}
      <ErrorText error={error} />
      <div className="attacks">
        {SCENARIOS.map((s) => {
          const r = attacks[s.id];
          return (
            <div className={`attack${r?.outcome ? (r.outcome === "allowed" ? " is-bad" : " is-ok") : ""}`} key={s.id}>
              <h3>{s.title}</h3>
              <p className="muted">{s.text}</p>
              <Button small kind="secondary" disabled={!c.grant} onClick={() => run(s.id)}>
                Try it
              </Button>
              {r && !r.ready ? <Banner tone="info">{r.hint}</Banner> : null}
              {r?.outcome ? (
                <div className="attack-result">
                  <strong>{r.outcome === "allowed" ? "NOT STOPPED" : r.outcome === "refused" ? "Refused" : "Would be refused"}</strong>
                  <ul>
                    {r.findings?.map((f) => (
                      <li key={f.code}>
                        <code>{f.code}</code> <span className="muted">({f.layer})</span> → <strong>{f.clause.title}</strong>: {f.clause.text}
                      </li>
                    ))}
                  </ul>
                  {r.fooled_ai_output ? <p className="hint">{r.fooled_ai_output.label}: accepted {r.fooled_ai_output.accepted_prs} PRs, asked for {usdText(r.fooled_ai_output.amount_usd)}.</p> : null}
                  <Json value={r.raw} label="Provider response" />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function SimControls({ c, config, onChange }: { c: ContractView; config: AppConfig; onChange: () => Promise<void> }) {
  const after = new Date(Date.parse(`${c.terms.end}T00:00:00Z`) + 36 * 3600_000).toISOString();
  return (
    <div className="simbar">
      <span>
        Simulated clock: <strong>{when(c.now)}</strong>
      </span>
      <Button kind="ghost" small onClick={async () => { await api("POST", "/sim/advance", { ms: config.timelock_ms + 1000 }); await onChange(); }}>
        Skip the {Math.round(config.timelock_ms / 60000)}-min timelock
      </Button>
      <Button kind="ghost" small onClick={async () => { await api("POST", "/sim/advance", { to: after }); await onChange(); }}>
        Jump past the end date
      </Button>
    </div>
  );
}

function Activity({ events }: { events: ContractView["events"] }) {
  if (!events.length) return null;
  return (
    <details className="activity" open>
      <summary>Activity</summary>
      <ol>
        {events.map((e) => (
          <li key={e.id}>
            <span className="muted">{when(e.at)}</span> {e.text}
          </li>
        ))}
      </ol>
    </details>
  );
}
