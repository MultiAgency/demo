import { useCallback, useEffect, useState } from "react";
import { fromAtomic } from "../../shared/money";
import { api, completeStep, links, signMessage } from "../api";
import { SignInGate } from "../components/Account";
import { Icon, type IconName } from "../components/icons";
import { type Act, ApprovalCard, ATTEMPT, NO_CLAUSE, PayoutsTab, StateNote } from "../components/Payouts";
import { PolicyCard } from "../components/PolicyCard";
import { ConfirmLink, SignBox } from "../components/SignBox";
import { Alert, Avatar, Badge, Button, Card, CardHeader, dateText, Mono, PageLoading, Progress, short, Spinner, Stat, Tabs, timeText, type Tone, usd } from "../components/ui";
import { PHASES, SETUP, STAGE_ORDER, type StepId } from "../guide";
import type { AppConfig, ContractView, Deposit, Judgment, NextStep, TermsSigningRequest, VerifyView } from "../types";
import { STAGES } from "./Home";

const LIVE_STATES = new Set(["pending", "waiting", "unknown", "processing"]);

export function ContractPage({ id, config }: { id: string; config: AppConfig }) {
  const [c, setC] = useState<ContractView | null>(null);
  const [verify, setVerify] = useState<VerifyView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api<ContractView>("GET", `/contracts/${id}`);
      setC(next);
      setVerify(next.platform.agent_id ? await api<VerifyView>("GET", `/contracts/${id}/verify`) : null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Follow attempts the platform hasn't finished with, and onboarding waits.
  useEffect(() => {
    if (!c) return;
    const live = c.payouts.some((p) => LIVE_STATES.has(p.state)) || c.next_step?.kind === "wait";
    if (!live) return;
    const t = setInterval(() => void load(), c.next_step?.kind === "wait" ? Math.max(1000, c.next_step.retry_ms) : 5000);
    return () => clearInterval(t);
  }, [c, load]);

  const act: Act = async (fn) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };

  if (!c) return error ? <div className="page"><Alert tone="danger">{error}</Alert></div> : <PageLoading />;

  const setup = c.stage.startsWith("needs_") || c.stage === "policy_pending";
  const stage = STAGES[c.stage] ?? { label: c.stage, tone: "neutral" as Tone };
  const verifyLink = `${window.location.origin}/#/c/${c.id}/verify`;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <a href="#/" className="crumb">
            <Icon name="chevronLeft" size={14} /> Contracts
          </a>
          <div className="title-row">
            <Avatar name={c.terms.contractor.name} tone="accent" />
            <div>
              <h1>{c.terms.contractor.name}</h1>
              <p className="page-sub">
                {c.terms.company} · {c.terms.scope.length} deliverables · {usd(c.total_usd)} scope
              </p>
            </div>
            <Badge tone={stage.tone} dot>
              {stage.label}
            </Badge>
          </div>
        </div>
        <div className="header-actions">
          <Mono copy={c.hash}>{`terms ${short(c.hash, 6, 4)}`}</Mono>
          {c.platform.agent_id ? <Mono copy={verifyLink}>Copy verify link</Mono> : null}
        </div>
      </header>

      <SignInGate account={c.terms.representative.near_account} role="representative" />
      {config.demo_controls ? <SimBar c={c} reload={load} /> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {setup ? <Setup c={c} config={config} act={act} /> : <Dashboard c={c} config={config} verify={verify} act={act} />}
    </div>
  );
}

/* ------------------------------------------------------------------ setup */

function stepState(c: ContractView, s: (typeof SETUP)[number], current: StepId | undefined): "done" | "current" | "todo" {
  if (s.id === "rep-sign") return c.signatures.representative ? "done" : current === s.id ? "current" : "todo";
  if (s.id === "contractor-sign") return c.signatures.contractor ? "done" : current === s.id ? "current" : "todo";
  const at = STAGE_ORDER.indexOf(c.stage === "policy_pending" ? "needs_policy" : c.stage);
  const mine = STAGE_ORDER.indexOf(s.stage);
  if (at < 0 || at > mine) return "done";
  return current === s.id ? "current" : "todo";
}

function currentStep(c: ContractView): StepId | undefined {
  if (!c.signatures.representative) return "rep-sign";
  if (!c.signatures.contractor) return "contractor-sign";
  const st = c.stage === "policy_pending" ? "needs_policy" : c.stage;
  return SETUP.find((s) => s.stage === st && s.id !== "rep-sign" && s.id !== "contractor-sign")?.id;
}

function Setup({ c, config, act }: { c: ContractView; config: AppConfig; act: Act }) {
  const current = currentStep(c);
  const currentPhase = SETUP.find((s) => s.id === current)?.phase ?? "live";
  const doneCount = SETUP.filter((s) => stepState(c, s, current) === "done").length;

  return (
    <div className="split">
      <div className="stack">
        <div className="phases">
          {PHASES.map((p, i) => {
            const idx = PHASES.findIndex((x) => x.id === currentPhase);
            const state = i < idx ? "done" : i === idx ? "current" : "todo";
            return (
              <div key={p.id} className={`phase phase-${state}`}>
                <span className="phase-n">{state === "done" ? <Icon name="check" size={13} strokeWidth={2.6} /> : i + 1}</span>
                {p.label}
              </div>
            );
          })}
        </div>

        <Card pad={false}>
          <div className="card-pad-x">
            <CardHeader title="Set up this contract" sub={`${doneCount} of ${SETUP.length} done`} />
            <Progress value={doneCount} max={SETUP.length} />
          </div>
          <ol className="checklist">
            {SETUP.map((s) => (
              <SetupRow key={s.id} step={s} c={c} config={config} act={act} state={stepState(c, s, current)} />
            ))}
          </ol>
        </Card>
      </div>

      <aside className="split-side">
        <div className="sticky">
          <div className="side-label">Contract policy</div>
          <PolicyCard
            payee={c.terms.payee.address}
            scope={c.terms.scope}
            start={c.terms.start}
            end={c.terms.end}
            repos={c.terms.repos}
            approver={c.terms.representative.near_account}
            status={c.platform.policy?.applied ? "live" : "draft"}
            agentId={c.platform.agent_id}
          />
          <p className="side-note">
            <Icon name="info" size={14} /> Organization <code>{c.organization}</code> on {c.platform.host}
            {config.platform === "fake" ? " (platform stand-in)" : ""}.
          </p>
        </div>
      </aside>
    </div>
  );
}

function stepDetail(c: ContractView, id: StepId): string | null {
  switch (id) {
    case "rep-sign":
      return c.signatures.representative ? `Signed by ${c.signatures.representative.account_id} · ${timeText(c.signatures.representative.signed_at)}` : null;
    case "contractor-sign":
      return c.signatures.contractor ? `Signed by ${c.signatures.contractor.account_id} · ${timeText(c.signatures.contractor.signed_at)}` : null;
    case "setup":
      return c.platform.agent ? `Agent ${c.platform.agent}` : null;
    case "create":
      return c.platform.agent_id ? `Agent id ${c.platform.agent_id}` : null;
    case "consent":
      return c.platform.consents ? `Payouts until ${timeText(c.platform.consents.payout_expires_at)} · read until ${dateText(c.platform.consents.owner_expires_at)}` : null;
    case "grant":
      return "Payout grant issued";
    case "policy":
      return c.platform.policy ? `Revision ${c.platform.policy.revision}${c.platform.policy.applied ? " · in force" : ""}` : null;
    case "fund":
      return c.platform.balance_usd ? `Balance ${usd(c.platform.balance_usd)}` : null;
  }
}

function SetupRow({ step, c, config, act, state }: { step: (typeof SETUP)[number]; c: ContractView; config: AppConfig; act: Act; state: "done" | "current" | "todo" }) {
  const [help, setHelp] = useState(false);
  const n = SETUP.findIndex((s) => s.id === step.id) + 1;
  const detail = (state === "done" ? stepDetail(c, step.id) : null) ?? step.short;

  return (
    <li className={`check-row is-${state}`}>
      <span className="check-icon">{state === "done" ? <Icon name="check" size={14} strokeWidth={2.6} /> : <Icon name={step.icon} size={15} />}</span>
      <div className="check-body">
        <div className="check-head">
          <div>
            <div className="check-title">
              <span className="check-n">{n}</span>
              {step.title}
            </div>
            <div className="check-sub">{detail}</div>
          </div>
          <button className="icon-btn" onClick={() => setHelp(!help)} aria-label={`About ${step.title}`} aria-expanded={help}>
            <Icon name="info" />
          </button>
        </div>
        {help ? (
          <ul className="check-help">
            {step.help.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        ) : null}
        {state === "current" ? <StepAction step={step.id} c={c} config={config} act={act} /> : null}
      </div>
    </li>
  );
}

function StepAction({ step, c, config, act }: { step: StepId; c: ContractView; config: AppConfig; act: Act }) {
  const token = links.get(c.id);

  const signTerms = (role: "representative" | "contractor") =>
    act(async () => {
      const req = await api<TermsSigningRequest>("GET", `/contracts/${c.id}/signing-request?role=${role}`);
      const s = await signMessage(config, req);
      await api("POST", `/contracts/${c.id}/signatures`, { role, signed: s, contractor_token: token });
    });

  switch (step) {
    case "rep-sign":
      return (
        <div className="check-action">
          <code className="mono message">Covenant work order sha256:{short(c.hash, 10, 6)}</code>
          <Button icon="pen" onClick={() => signTerms("representative")} disabled={!config.demo_controls}>
            {config.demo_controls ? `Sign as ${c.terms.representative.near_account}` : "Sign with wallet"}
          </Button>
        </div>
      );
    case "contractor-sign": {
      const link = token ? `${window.location.origin}/#/c/${c.id}/sign?t=${token}` : null;
      return (
        <div className="check-action col">
          {link ? (
            <div className="share">
              <Icon name="link" size={14} />
              <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Contractor signing link" />
              <Mono copy={link}>Copy</Mono>
              <a className="btn btn-ghost btn-sm" href={`#/c/${c.id}/sign?t=${token}`} target="_blank" rel="noreferrer">
                <Icon name="external" /> <span>Open</span>
              </a>
            </div>
          ) : (
            <Alert tone="warning">The signing link is only shown in the browser that created the draft.</Alert>
          )}
          {config.demo_controls && token ? (
            <Button variant="secondary" icon="pen" onClick={() => signTerms("contractor")}>
              Sign as {c.terms.contractor.near_account} (demo shortcut)
            </Button>
          ) : null}
        </div>
      );
    }
    case "fund":
      return <DepositCard c={c} config={config} act={act} />;
    default:
      return <NextStepAction c={c} config={config} act={act} />;
  }
}

/** The platform onboarding steps, driven by the server's NextStep. */
function NextStepAction({ c, config, act }: { c: ContractView; config: AppConfig; act: Act }) {
  const [step, setStep] = useState<NextStep | null>(c.next_step);
  useEffect(() => setStep(c.next_step), [c.next_step]);

  const fetchNext = () => act(async () => setStep(await api<NextStep>("POST", `/contracts/${c.id}/onboarding/next`)));
  const run = (s: NextStep) => act(async () => setStep(await completeStep(config, c.id, s)));

  if (!step)
    return (
      <div className="check-action">
        <Button icon="arrowRight" onClick={fetchNext}>
          Continue
        </Button>
      </div>
    );
  switch (step.kind) {
    case "sign":
      return (
        <div className="check-action col">
          <span className="small">{step.label}</span>
          <SignBox config={config} req={step.sign} label="Sign" onSign={() => run(step)} />
        </div>
      );
    case "owner_step":
      return (
        <div className="check-action col">
          <span className="small">
            <strong>{step.label}.</strong> {step.summary}
          </span>
          {step.sign ? <SignBox config={config} req={step.sign} label="Sign" onSign={() => run(step)} /> : null}
          {step.confirm ? <ConfirmLink config={config} url={step.confirm.url} expiresAt={step.confirm.expires_at} onDemoComplete={() => run(step)} /> : null}
          {!config.demo_controls ? (
            <Button variant="secondary" size="sm" onClick={fetchNext}>
              I've signed it
            </Button>
          ) : null}
        </div>
      );
    case "wait":
      return (
        <div className="check-action">
          <Spinner /> <span className="muted small">{step.label}</span>
          <WaitPoll ms={step.retry_ms} onTick={fetchNext} />
        </div>
      );
    case "done":
      return null;
  }
}

function WaitPoll({ ms, onTick }: { ms: number; onTick: () => Promise<void> }) {
  useEffect(() => {
    const t = setTimeout(() => void onTick(), Math.max(1000, ms));
    return () => clearTimeout(t);
  }, [ms, onTick]);
  return null;
}

function DepositCard({ c, config, act }: { c: ContractView; config: AppConfig; act: Act }) {
  const [d, setD] = useState<Deposit | null>(c.platform.deposit);
  useEffect(() => {
    if (!d) void api<Deposit>("POST", `/contracts/${c.id}/deposit`).then(setD, () => undefined);
  }, [c.id, d]);
  return (
    <div className="check-action col">
      {d ? (
        <div className="deposit">
          <div className="kv-line">
            <span>Send</span>
            <strong>{usd(c.total_usd)} USDC on NEAR, exactly the scope</strong>
          </div>
          <div className="kv-line">
            <span>To</span>
            <Mono copy={d.address}>{short(d.address, 12, 8)}</Mono>
          </div>
          {d.memo ? (
            <div className="kv-line">
              <span>Memo</span>
              <Mono copy={d.memo}>{d.memo}</Mono>
            </div>
          ) : null}
          {d.minAmount ? (
            <div className="kv-line">
              <span>Minimum</span>
              <span>{usd(fromAtomic(BigInt(d.minAmount), 6))}</span>
            </div>
          ) : null}
          {d.expiresAt ? (
            <div className="kv-line">
              <span>Address expires</span>
              <span>{timeText(d.expiresAt)}</span>
            </div>
          ) : null}
        </div>
      ) : (
        <span className="muted small">
          <Spinner /> Getting a deposit address…
        </span>
      )}
      {config.demo_controls && c.platform.agent_id ? (
        <Button icon="coins" onClick={() => act(() => api("POST", "/sim/fund", { contract_id: c.id, agent_id: c.platform.agent_id, usd: c.total_usd }))}>
          Fund {usd(c.total_usd)} (demo)
        </Button>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- dashboard */

type TabId = "scope" | "payouts" | "security" | "policy" | "activity";

function Dashboard({ c, config, verify, act }: { c: ContractView; config: AppConfig; verify: VerifyView | null; act: Act }) {
  const [tab, setTab] = useState<TabId>("scope");
  const total = Number(c.total_usd);
  const paid = Number(c.paid_usd);
  const daysLeft = Math.ceil((Date.parse(`${c.terms.end}T23:59:59Z`) - Date.parse(c.now)) / 86_400_000);
  const payouts = c.payouts.filter((p) => p.kind === "payout");
  const held = payouts.filter((p) => p.state === "held");
  const attention = payouts.filter((p) => p.state === "blocked" || (p.state === "failed" && !p.resolution) || p.state === "unknown").length;

  return (
    <>
      {c.stage === "frozen" ? <Alert tone="danger" icon="snowflake">This contract's agent is frozen. It can't pay anything.</Alert> : null}
      {c.stage === "ended" ? <Alert tone="info" icon="calendar">This contract ended on {dateText(c.terms.end)}. Covenant can't request payouts any more; you can still approve or reject held ones.</Alert> : null}
      {held.length ? (
        <Alert tone="warning" icon="alert">
          {held.length} payout{held.length === 1 ? "" : "s"} wait{held.length === 1 ? "s" : ""} for your approval. See Payouts.
        </Alert>
      ) : null}
      {attention ? (
        <Alert tone="danger" icon="alert">
          {attention} payout{attention === 1 ? " needs" : "s need"} attention. See Payouts.
        </Alert>
      ) : null}

      <div className="stats-row four">
        <Stat label="Paid for the scope" icon="coins" value={usd(paid)} sub={`of ${usd(total)}`}>
          <Progress value={paid} max={total} />
        </Stat>
        <Stat label="Agent balance" icon="wallet" value={c.platform.balance_usd === null ? "—" : usd(c.platform.balance_usd)} sub="USDC" />
        <Stat label="Awaiting approval" icon="shield" value={held.length ? usd(held.reduce((n, p) => n + Number(p.amount_usd), 0)) : "—"} sub={held.length ? `${held.length} held` : "Nothing held"} />
        <Stat label="Contract ends" icon="calendar" value={dateText(c.terms.end)} sub={daysLeft > 0 ? `${daysLeft} days left` : "Ended"} />
      </div>

      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        items={[
          { id: "scope", label: "Scope", icon: "file" },
          { id: "payouts", label: "Payouts", icon: "coins", count: payouts.length },
          { id: "security", label: "Security test", icon: "shield" },
          { id: "policy", label: "Policy & verify", icon: "shieldCheck" },
          { id: "activity", label: "Activity", icon: "activity" },
        ]}
      />

      {tab === "scope" ? <ScopeTab c={c} config={config} act={act} onPayouts={() => setTab("payouts")} /> : null}
      {tab === "payouts" ? <PayoutsTab c={c} config={config} act={act} /> : null}
      {tab === "security" ? <SecurityTab c={c} config={config} act={act} /> : null}
      {tab === "policy" ? <PolicyTab c={c} verify={verify} /> : null}
      {tab === "activity" ? <ActivityTab c={c} /> : null}
    </>
  );
}

/** The scoreboard: each deliverable, what it's worth, how done it is, what's been paid. */
function ScopeTab({ c, config, act, onPayouts }: { c: ContractView; config: AppConfig; act: Act; onPayouts: () => void }) {
  const j = (c.judgment ?? null) as Judgment | null;
  const outOfScope = (j?.prs ?? []).filter((p) => !p.eligible || !p.deliverable);
  return (
    <Card pad={false}>
      <div className="card-pad-x">
        <CardHeader
          title="Scope"
          sub={j ? `Last judged ${timeText(j.at)} by ${j.judge === "near-ai" ? `NEAR AI (${j.model ?? "model"})` : "the rule-based judge"}` : "Not judged yet. Check merges to start."}
          actions={
            <Button icon="play" disabled={c.stage !== "active"} onClick={() => act(() => api("POST", `/contracts/${c.id}/run`))}>
              Check merges
            </Button>
          }
        />
      </div>
      <ul className="scoreboard">
        {c.scope.map((d) => {
          const value = Number(d.value_usd);
          const paid = Number(d.paid_usd);
          const inFlight = Math.max(0, Number(d.committed_usd) - paid);
          return (
            <li key={d.id} className={d.completion >= 1 && paid >= value ? "is-done" : ""}>
              <div className="sb-head">
                <span className="scope-id">{d.id}</span>
                <div className="sb-title">
                  <strong>{d.title}</strong>
                  <span>{d.criteria}</span>
                </div>
                <span className="sb-value num">{usd(value)}</span>
              </div>
              <div className="sb-bar">
                <Progress value={d.completion * 100} max={100} />
                <span className="num">{Math.round(d.completion * 100)}%</span>
              </div>
              <div className="sb-meta">
                <span className="pill-mini ok">
                  <Icon name="check" size={12} /> {usd(paid)} paid
                </span>
                {inFlight ? (
                  <button className="pill-mini warn linkish" onClick={onPayouts}>
                    <Icon name="shield" size={12} /> {usd(inFlight)} awaiting approval or settlement
                  </button>
                ) : null}
                {d.prs.map((pr) => (
                  <a key={pr.key} className={`pr-chip${pr.flagged ? " warn" : ""}`} href={pr.url} target="_blank" rel="noreferrer" title={pr.flagged ? `Flagged: ${pr.title}` : pr.title}>
                    <Icon name={pr.flagged ? "alert" : "pr"} size={12} /> {pr.key.split("/")[1]}
                  </a>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      {outOfScope.length ? (
        <div className="card-pad-x out-of-scope">
          <div className="side-label">Not counted</div>
          <ul className="prs">
            {outOfScope.map((pr) => (
              <li key={pr.key} className={pr.flags.length ? "warn" : "no"}>
                <Icon name={pr.flags.length ? "alert" : "x"} size={14} />
                <a href={pr.url} target="_blank" rel="noreferrer" className="pr-key">
                  {pr.key}
                </a>
                <span className="pr-title">{pr.title}</span>
                <span className="pr-reason">{pr.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {config.demo_controls ? <p className="card-pad-x fineprint pad-b">Demo PRs link to a deliverable with a "Scope: d2" line. Use “Simulate a merge” above to land the next one.</p> : <div className="pad-b" />}
    </Card>
  );
}

/* ------------------------------------------------------------ security test */

const ATTACKS: { id: string; icon: IconName; title: string; text: string; fakeOnly?: boolean }[] = [
  { id: "redirect", icon: "send", title: "Redirect", text: "Pay attacker.demo instead of the payee" },
  { id: "overpay", icon: "coins", title: "Overpay", text: "Pay $1 more than the largest deliverable" },
  { id: "injected", icon: "bot", title: "Prompt injection", text: "A PR talks the judge into an in-cap payout" },
  { id: "after_end", icon: "calendar", title: "After the end", text: "Request a payout once the contract ended", fakeOnly: true },
];

function SecurityTab({ c, config, act }: { c: ContractView; config: AppConfig; act: Act }) {
  const attacks = ATTACKS.filter((a) => !a.fakeOnly || config.platform === "fake");
  const allowed = config.demo_controls;
  const latest = (id: string) => c.payouts.find((p) => p.kind === "attack" && p.request_id.startsWith(`atk-${id}-`));
  const run = (id: string) => act(() => api("POST", `/contracts/${c.id}/attacks/${id}`));
  const runAll = () =>
    act(async () => {
      for (const a of attacks) await api("POST", `/contracts/${c.id}/attacks/${a.id}`);
    });

  return (
    <Card>
      <CardHeader
        icon="shield"
        title="Compromised-server test"
        sub="Real payout requests with Covenant's own checks skipped. The platform's policy and your approval are what stop them."
        actions={
          <Button icon="zap" onClick={runAll} disabled={!allowed || c.stage !== "active"}>
            Run all
          </Button>
        }
      />
      {!allowed ? <Alert tone="info">Attacks run only against the platform stand-in or the local stack, never with real funds.</Alert> : null}
      <div className="attacks">
        {attacks.map((a) => {
          const p = latest(a.id);
          const stopped = p && (p.state === "refused" || p.state === "blocked" || p.state === "rejected");
          return (
            <div key={a.id} className={`attack${p ? (stopped ? " is-blocked" : p.state === "held" ? " is-held" : " is-allowed") : ""}`}>
              <div className="attack-top">
                <span className="icon-tile">
                  <Icon name={a.icon} />
                </span>
                <div className="attack-copy">
                  <h3>{a.title}</h3>
                  <p>{a.text}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => run(a.id)} disabled={!allowed || c.stage !== "active"}>
                  Run
                </Button>
              </div>
              {p ? (
                <div className="attack-result">
                  <div className="attack-verdict">
                    <Icon name={stopped ? "shieldCheck" : p.state === "held" ? "shield" : "shieldX"} size={18} />
                    {p.state === "refused"
                      ? "Refused by the platform"
                      : p.state === "blocked"
                        ? "Refused by the gateway"
                        : p.state === "rejected"
                          ? "Rejected by you. Nothing moved."
                          : p.state === "held"
                            ? "Held for approval"
                            : ATTEMPT[p.state].label}
                  </div>
                  {p.state === "refused" || p.state === "blocked" ? (
                    <div className="chips">
                      <span className="chip" title={p.clause?.text ?? NO_CLAUSE}>
                        <Icon name="lock" size={12} /> {p.clause ? p.clause.title.replace(" clause", "") : NO_CLAUSE} {p.code ? <code>{p.code}</code> : null}
                      </span>
                    </div>
                  ) : null}
                  {p.clause && (p.state === "refused" || p.state === "blocked") ? <p className="muted small">{p.clause.text}</p> : null}
                  {p.state === "held" ? <ApprovalCard p={p} config={config} act={act} attack /> : null}
                  {p.state !== "held" && p.state !== "refused" && p.state !== "blocked" ? <StateNote p={p} act={act} /> : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------- policy, activity */

function PolicyTab({ c, verify }: { c: ContractView; verify: VerifyView | null }) {
  return (
    <div className="split even">
      <div className="stack">
        <PolicyCard
          payee={c.terms.payee.address}
          scope={c.terms.scope}
          start={c.terms.start}
          end={c.terms.end}
          repos={c.terms.repos}
          approver={c.terms.representative.near_account}
          status={c.stage === "frozen" ? "frozen" : c.stage === "ended" ? "ended" : "live"}
          agentId={c.platform.agent_id}
        />
      </div>
      <Card>
        <CardHeader
          icon="shieldCheck"
          title="Verification"
          sub="The platform's policy against the signed terms"
          actions={
            <a className="btn btn-secondary btn-sm" href={`#/c/${c.id}/verify`} target="_blank" rel="noreferrer">
              <Icon name="external" /> <span>Open</span>
            </a>
          }
        />
        {verify ? (
          <ul className="checks">
            {verify.checks.map((x) => (
              <li key={x.id} className={x.info ? "warn" : x.ok ? "ok" : "bad"}>
                <Icon name={x.info ? "info" : x.ok ? "check" : "x"} size={14} strokeWidth={2.4} />
                {x.label}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Available once the agent exists.</p>
        )}
      </Card>
    </div>
  );
}

function ActivityTab({ c }: { c: ContractView }) {
  const icon: Record<string, IconName> = {
    draft: "file",
    signed: "pen",
    setup: "building",
    agent: "wallet",
    consent: "key",
    grant: "key",
    policy: "shield",
    funded: "coins",
    run: "bot",
    deferred: "clock",
    sent: "send",
    held: "shield",
    paid: "check",
    approve: "check",
    reject: "x",
    refused: "shieldCheck",
    blocked: "ban",
    failed: "alert",
    resolve: "check",
    retry: "play",
    drop: "x",
    freeze: "snowflake",
    attack: "shield",
  };
  return (
    <Card>
      <ol className="timeline">
        {c.events.map((e) => (
          <li key={e.id}>
            <span className="tl-icon">
              <Icon name={icon[e.kind] ?? "activity"} size={14} />
            </span>
            <div>
              <div className="tl-text">{e.text}</div>
              <div className="tl-time">{timeText(e.at)}</div>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/* ---------------------------------------------------------------- sim bar */

function SimBar({ c, reload }: { c: ContractView; reload: () => Promise<void> }) {
  const after = new Date(Date.parse(`${c.terms.end}T00:00:00Z`) + 36 * 3600_000).toISOString();
  const settling = c.payouts.some((p) => p.state === "processing");
  const post = async (path: string, body: unknown) => {
    await api("POST", path, body).catch(() => undefined);
    await reload();
  };
  return (
    <div className="simbar">
      <span className="simbar-label">
        <Icon name="clock" size={14} /> Demo time <strong>{timeText(c.now)}</strong>
      </span>
      <button
        className="simbar-btn"
        onClick={async () => {
          await api("POST", "/sim/merge", { contract_id: c.id });
          await api("POST", `/contracts/${c.id}/run`).catch(() => undefined);
          await reload();
        }}
      >
        <Icon name="pr" size={13} /> Simulate a merge
      </button>
      <button className="simbar-btn" disabled={!settling} onClick={() => post("/sim/settle", { contract_id: c.id })}>
        <Icon name="send" size={13} /> Settle approved payouts
      </button>
      <button className="simbar-btn" onClick={() => post("/sim/advance", { to: after })}>
        <Icon name="fastForward" size={13} /> Jump past end date
      </button>
    </div>
  );
}
