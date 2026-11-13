import { JobFunding } from "../components/JobFunding";
import { FundingRecovery } from "../components/FundingRecovery";
import { DaoProposal } from "../components/DaoProposal";
import { useCallback, useEffect, useState } from "react";
import { api, completeStep, links, signMessage } from "../api";
import { SignInGate } from "../components/Account";
import { PayeeCheck } from "../components/PayeeRegistration";
import { AgencyJobWorkflow } from "../components/JobWorkflow";
import { Icon, type IconName } from "../components/icons";
import { type Act, ApprovalCard, ATTEMPT, NO_CLAUSE, PayoutsTab, StateNote } from "../components/Payouts";
import { PolicyCard } from "../components/PolicyCard";
import { ConfirmLink, SignBox } from "../components/SignBox";
import { Alert, Avatar, Badge, Button, Card, CardHeader, dateText, Mono, PageLoading, Progress, short, Spinner, Stat, Tabs, timeText, type Tone, usd } from "../components/ui";
import { PHASES, SETUP, STAGE_ORDER, type StepId } from "../guide";
import { AccountReadGate, useAccountResource } from "../useAccountResource";
import type { AppConfig, ContractView, Judgment, NextStep, TermsSigningRequest, VerifyView } from "../types";
import { STAGES } from "./Home";
import { capsAtScope, endInstant, isMarketSettled, type MarketTerms, payoutEndInstant, titleOf } from "../../shared/terms";
import { useSession } from "../session";

export function ContractPage({ id, config }: { id: string; config: AppConfig }) {
  const read = useCallback(async () => {
    const contract = await api<ContractView>("GET", `/contracts/${id}`);
    const verify = contract.platform.agent_id ? await api<VerifyView>("GET", `/contracts/${id}/verify`) : null;
    return { contract, verify };
  }, [id]);
  const resource = useAccountResource(`contract:${id}`, read, { refreshMs: 5000 });
  const c = resource.value?.contract ?? null;
  const verify = resource.value?.verify ?? null;
  const load = resource.reload;
  const [actionError, setActionError] = useState<{ scope: string | null; message: string } | null>(null);
  const error = resource.error
    ? c ? `Status could not refresh. Showing the last confirmed status. ${resource.error}` : resource.error
    : (actionError?.scope === resource.scope ? actionError.message : null);

  const act: Act = async (fn) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError({ scope: resource.scope, message: (e as Error).message });
    }
    await load();
  };

  if (!resource.enabled) return <AccountReadGate />;
  if (!c) return error ? <div className="page stack"><h1>Job unavailable</h1><Alert tone="danger">{error}</Alert><div className="header-actions"><Button variant="secondary" onClick={load}>Retry loading job</Button><a className="btn btn-secondary btn-sm" href="#/">Assigned to me</a></div></div> : <PageLoading />;

  const setup = c.stage.startsWith("needs_") || c.stage === "policy_pending";
  const stage = STAGES[c.stage] ?? { label: c.stage, tone: "neutral" as Tone };
  const verifyLink = `${window.location.origin}/#/c/${c.id}/verify`;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <a href="#/" className="crumb">
            <Icon name="chevronLeft" size={14} /> Jobs
          </a>
          <div className="title-row">
            <Avatar name={c.terms.contractor.name} tone="accent" />
            <div>
              <h1>{titleOf(c.terms) ?? c.terms.contractor.name}</h1>
              <p className="page-sub">
                {titleOf(c.terms) ? `${c.terms.contractor.name} · ` : ""}{c.terms.company} · {c.terms.scope.length} deliverables · {usd(c.total_usd)} scope
              </p>
            </div>
            <Badge tone={stage.tone} dot>
              {stage.label}
            </Badge>
          </div>
        </div>
        <div className="header-actions">
          {c.terms.v === 3 && links.get(c.id) ? <a data-action="open-builder-workflow" className="btn btn-secondary btn-sm" href={`#/c/${c.id}/sign?t=${links.get(c.id)}`} target="_blank" rel="noreferrer"><Icon name="external" /> <span>{c.signatures.contractor ? "Builder submission" : "Builder invitation"}</span></a> : null}
          <Mono copy={c.hash}>{`terms ${short(c.hash, 6, 4)}`}</Mono>
          {c.platform.agent_id ? <Mono copy={verifyLink}>Copy verify link</Mono> : null}
          {c.platform.agent && c.stage !== "frozen" && c.stage !== "ended" ? (
            <a
              className="btn btn-secondary btn-sm"
              href={walletStopUrl(c)}
              target="_blank"
              rel="noreferrer"
              title="The owner freezes the agent on the platform's wallet stop page (needs platform 0.5.5). Nothing pays until they unfreeze it."
            >
              <Icon name="snowflake" /> <span>Freeze on the platform</span>
            </a>
          ) : null}
        </div>
      </header>

      <SignInGate account={c.terms.representative.near_account} role="representative" />
      {config.demo_controls ? <SimBar c={c} reload={load} /> : null}
      {!config.demo_controls && !isMarketSettled(c.terms) && c.signatures.contractor && c.stage !== "ended" ? <PayeeCheck key={c.id} id={c.id} account={c.terms.payee.address} /> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {!config.demo_controls && !isMarketSettled(c.terms) && c.platform.agent_id ? <FundingRecovery key={c.id} c={c} /> : null}

      {setup ? <Setup c={c} config={config} act={act} reload={load} /> : <Dashboard c={c} config={config} verify={verify} act={act} />}
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

function Setup({ c, config, act, reload }: { c: ContractView; config: AppConfig; act: Act; reload: () => Promise<void> }) {
  const current = currentStep(c);
  const currentPhase = SETUP.find((s) => s.id === current)?.phase ?? "live";
  const doneCount = SETUP.filter((s) => stepState(c, s, current) === "done").length;
  const session = useSession();
  const [running, setRunning] = useState(false);
  // Wallet-owned platform steps can run back to back. A DAO vote, a platform confirm page or a wait ends the run.
  const guided = !!current && ["setup", "create", "consent", "grant", "policy"].includes(current) && !(c.terms.v === 3 && c.terms.agency_owner);
  const runSetup = () => {
    setRunning(true);
    return act(async () => {
      let step: NextStep | null = c.next_step ?? await api<NextStep>("POST", `/contracts/${c.id}/onboarding/next`);
      // Each signature is still its own wallet approval; the run only removes the clicks between them.
      for (let i = 0; i < SETUP.length && step && (step.kind === "sign" || (step.kind === "owner_step" && !!step.sign && !step.dao)); i++)
        step = await completeStep(config, c.id, step, session.signWorkflow);
    }).finally(() => setRunning(false));
  };

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
            <CardHeader title="Set up this job" sub={`${doneCount} of ${SETUP.length} done`} actions={<>
              {guided ? <Button size="sm" icon="arrowRight" busy={running} onClick={runSetup}>Sign remaining setup steps</Button> : null}
              <Button variant="secondary" size="sm" onClick={reload}>Refresh status</Button>
            </>} />
            <Progress value={doneCount} max={SETUP.length} label="Job setup" />
            <p className="muted small" role="status">Status refreshes automatically, including when you return from the platform. Each new signature still needs your approval.</p>
          </div>
          <ol className="checklist">
            {(isMarketSettled(c.terms) ? SETUP.filter((s) => s.id === "rep-sign" || s.id === "contractor-sign") : SETUP).map((s) => (
              <SetupRow key={s.id} step={s} c={c} config={config} act={act} reload={reload} state={stepState(c, s, current)} />
            ))}
          </ol>
        </Card>
      </div>

      <aside className="split-side">
        <div className="sticky">
          <div className="side-label">{isMarketSettled(c.terms) ? "Settlement" : "Job policy"}</div>
          {isMarketSettled(c.terms) ? <MarketSettlementCard terms={c.terms} /> : <>
            <PolicyCard
              payee={c.terms.payee.address}
              scope={c.terms.scope}
              start={c.terms.start}
              end={c.terms.end}
              payUntil={payoutEndInstant(c.terms).slice(0, 10)}
              repos={c.terms.repos}
              approver={c.terms.v === 3 && c.terms.agency_owner ? c.terms.agency_owner.account_id : c.terms.representative.near_account}
              status={c.platform.policy?.applied ? "live" : "draft"}
              agentId={c.platform.agent_id}
              standIn={c.platform.mode === "fake"}
              reportWorkflow={c.terms.v === 3}
              capAtScope={capsAtScope(c.terms)}
            />
            {c.terms.v === 3 && c.terms.market_source ? <p className="side-note">Sourced from Agent Market job <code>{c.terms.market_source.job_id}</code>. This job is paid only through the platform; setup and funding wait until that Market job is closed.</p> : null}
          </>}
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
      return c.platform.agent_id ? `Agent id ${short(c.platform.agent_id, 10, 6)}` : null;
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

function SetupRow({ step, c, config, act, reload, state }: { step: (typeof SETUP)[number]; c: ContractView; config: AppConfig; act: Act; reload: () => Promise<void>; state: "done" | "current" | "todo" }) {
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
        {state === "current" ? <StepAction step={step.id} c={c} config={config} act={act} reload={reload} /> : null}
      </div>
    </li>
  );
}

function StepAction({ step, c, config, act, reload }: { step: StepId; c: ContractView; config: AppConfig; act: Act; reload: () => Promise<void> }) {
  const session = useSession();
  const token = links.get(c.id);

  const signTerms = (role: "representative" | "contractor") =>
    act(async () => {
      const req = await api<TermsSigningRequest>("GET", `/contracts/${c.id}/signing-request?role=${role}`);
      const s = await signMessage(config, req, session.signWorkflow);
      await api("POST", `/contracts/${c.id}/signatures`, { role, signed: s, contractor_token: token });
    });

  switch (step) {
    case "rep-sign":
      return (
        <div className="check-action">
          <code className="mono message">Job terms sha256:{short(c.hash, 10, 6)}</code>
          <Button icon="pen" onClick={() => signTerms("representative")} disabled={!config.demo_controls && (session.loading || session.account !== c.terms.representative.near_account)}>
            {config.demo_controls ? `Sign as ${c.terms.representative.near_account}` : "Sign with wallet"}
          </Button>
        </div>
      );
    case "contractor-sign": {
      // With sign-in the named builder's own session opens the offer, so the link works without the private token.
      const link = token ? `${window.location.origin}/#/c/${c.id}/sign?t=${token}` : config.auth.required ? `${window.location.origin}/#/c/${c.id}/sign` : null;
      return (
        <div className="check-action col">
          {link ? (
            <div className="share">
              <Icon name="link" size={14} />
              <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Builder signing link" />
              <Mono copy={link}>Copy</Mono>
              <a className="btn btn-ghost btn-sm" href={link} target="_blank" rel="noreferrer">
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
      return <JobFunding c={c} config={config} act={act} />;
    default:
      return <NextStepAction c={c} config={config} act={act} reload={reload} />;
  }
}

/** The platform onboarding steps, driven by the server's NextStep. */
function NextStepAction({ c, config, act, reload }: { c: ContractView; config: AppConfig; act: Act; reload: () => Promise<void> }) {
  const session = useSession();
  // One authoritative snapshot: an older polling response cannot replace a newly completed step locally.
  const step = c.next_step;
  const fetchNext = () => act(() => api<NextStep>("POST", `/contracts/${c.id}/onboarding/next`));
  const run = (s: NextStep) => act(() => completeStep(config, c.id, s, session.signWorkflow));

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
    case "dao_vote":
      return <DaoProposal proposal={step.request} onCheck={reload} />;
    case "owner_step":
      return (
        <div className="check-action col">
          <span className="small">
            <strong>{step.label}.</strong> {step.summary}
          </span>
          {step.dao ? <DaoProposal proposal={step.dao} onCheck={reload} /> : null}
          {step.sign ? <SignBox config={config} req={step.sign} label="Sign" onSign={() => run(step)} /> : null}
          {step.confirm ? <ConfirmLink config={config} url={step.confirm.url} expiresAt={step.confirm.expires_at} onDemoComplete={() => run(step)} /> : null}
          {!config.demo_controls ? (
            <Button variant="secondary" size="sm" onClick={reload}>
              Refresh status
            </Button>
          ) : null}
        </div>
      );
    case "wait":
      return (
        <div className="check-action">
          {step.error ? <Alert tone="danger">{step.error}</Alert> : <><Spinner /> <span className="muted small">{step.label}</span></>}
          <Button variant="secondary" size="sm" onClick={reload}>Refresh status</Button>
        </div>
      );
    case "done":
      return null;
  }
}

/* -------------------------------------------------------------- dashboard */

type TabId = "job" | "scope" | "payouts" | "security" | "policy" | "activity";

function Dashboard({ c, config, verify, act }: { c: ContractView; config: AppConfig; verify: VerifyView | null; act: Act }) {
  const [tab, setTab] = useState<TabId>(c.terms.v === 3 ? "job" : "scope");
  const total = Number(c.total_usd);
  const paid = Number(c.paid_usd);
  const daysLeft = Math.ceil((Date.parse(endInstant(c.terms)) - Date.parse(c.now)) / 86_400_000);
  // A signed review window keeps review and payment open after the work deadline.
  const payUntil = payoutEndInstant(c.terms).slice(0, 10);
  const reviewing = daysLeft <= 0 && c.stage !== "ended" && payUntil !== c.terms.end;
  const payouts = c.payouts.filter((p) => p.kind === "payout");
  // Held payouts of a submission with requested changes need a signed rejection, not an approval decision.
  const cancelling = new Set(c.submissions.filter((s) => s.state === "changes_pending").flatMap((s) => s.payout_request_ids));
  const held = payouts.filter((p) => p.state === "held" && !cancelling.has(p.request_id));
  const toCancel = payouts.filter((p) => p.state === "held" && cancelling.has(p.request_id));
  const attention = payouts.filter((p) => p.state === "blocked" || (p.state === "failed" && !p.resolution) || p.state === "unknown").length;

  return (
    <>
      {c.stage === "frozen" ? (
        <Alert tone="danger" icon="snowflake">
          The owner froze this job's agent. Nothing pays until they unfreeze it on the platform; Paperwork then checks the policy against the signed terms and carries on.
        </Alert>
      ) : null}
      {c.stage === "ended" ? <Alert tone="info" icon="calendar">This job ended on {dateText(payUntil)}. Paperwork can't request payouts any more; you can still approve or reject held ones.</Alert> : null}
      {reviewing ? <Alert tone="info" icon="calendar">The submission deadline passed on {dateText(c.terms.end)}. You can still review submitted work and approve payouts until {dateText(payUntil)}.</Alert> : null}
      {held.length ? (
        <Alert tone="warning" icon="alert">
          {held.length} payout{held.length === 1 ? "" : "s"} wait{held.length === 1 ? "s" : ""} for your approval. See {c.terms.v === 3 ? "Submission & review" : "Payouts"}.
        </Alert>
      ) : null}
      {toCancel.length ? (
        <Alert tone="warning" icon="alert">
          You requested changes. Sign the rejection of the held {toCancel.length === 1 ? "payout" : `${toCancel.length} payouts`} so the builder can revise. See Submission &amp; review.
        </Alert>
      ) : null}
      {attention ? (
        <Alert tone="danger" icon="alert">
          {attention} payout{attention === 1 ? " needs" : "s need"} attention. See {c.terms.v === 3 ? "Submission & review" : "Payouts"}.
        </Alert>
      ) : null}

      <div className="stats-row four">
        <Stat label="Paid for the scope" icon="coins" value={usd(paid)} sub={`of ${usd(total)}`}>
          <Progress value={paid} max={total} label="Recorded scope payment" />
        </Stat>
        {isMarketSettled(c.terms)
          ? <Stat label="Settlement" icon="wallet" value="Agent Market" sub="Awarded price, released on Market acceptance" />
          : <Stat label="Agent balance" icon="wallet" value={c.platform.balance_usd === null ? "—" : usd(c.platform.balance_usd)} sub="USDC" />}
        <Stat label="Awaiting approval" icon="shield" value={held.length ? usd(held.reduce((n, p) => n + Number(p.amount_usd), 0)) : "—"} sub={held.length ? `${held.length} held` : "Nothing held"} />
        <Stat label="Job ends" icon="calendar" value={dateText(c.terms.end)} sub={daysLeft > 0 ? `${daysLeft} days left` : reviewing ? `Review until ${dateText(payUntil)}` : "Ended"} />
      </div>

      <Tabs<TabId>
        id="job-sections"
        value={tab}
        onChange={setTab}
        items={[
          ...(c.terms.v === 3 ? [{ id: "job" as const, label: "Submission & review", icon: "file" as const, count: c.submissions.length }] : []),
          { id: "scope", label: "Scope", icon: "file" },
          ...(c.terms.v === 2 ? [{ id: "payouts" as const, label: "Payouts", icon: "coins" as const, count: payouts.length }] : []),
          ...(config.demo_controls ? [{ id: "security" as const, label: "Security test", icon: "shield" as const }] : []),
          { id: "policy", label: "Policy & verify", icon: "shieldCheck" },
          { id: "activity", label: "Activity", icon: "activity" },
        ]}
      />

      <section role="tabpanel" id="job-sections-panel" aria-labelledby={`job-sections-${tab}`} tabIndex={0}>
      {tab === "job" ? <AgencyJobWorkflow c={c} config={config} act={act} /> : null}
      {tab === "scope" ? <ScopeTab c={c} config={config} act={act} onPayouts={() => setTab(c.terms.v === 3 ? "job" : "payouts")} /> : null}
      {tab === "payouts" ? <PayoutsTab c={c} config={config} act={act} /> : null}
      {tab === "security" ? <SecurityTab c={c} config={config} act={act} /> : null}
      {tab === "policy" ? <PolicyTab c={c} verify={verify} /> : null}
      {tab === "activity" ? <ActivityTab c={c} /> : null}
      </section>
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
          sub={j ? `Last judged ${timeText(j.at)} by ${j.judge === "near-ai" ? `NEAR AI (${j.model ?? "model"})` : "the rule-based judge"}` : c.terms.v === 3 ? "Agreed acceptance criteria and maximum values. Review the builder's submission to propose compensation." : "Not judged yet. Check merges to start."}
          actions={
            c.terms.v === 2 ?
            <Button icon="play" disabled={c.stage !== "active"} onClick={() => act(() => api("POST", `/contracts/${c.id}/run`))}>
              Check merges
            </Button>
            : null
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
                <Progress value={d.completion * 100} max={100} label={`${d.title} completion`} />
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
      {config.demo_controls && c.terms.v === 2 ? <p className="card-pad-x fineprint pad-b">Demo PRs link to a deliverable with a "Scope: d2" line. Use “Simulate a merge” above to land the next one.</p> : <div className="pad-b" />}
    </Card>
  );
}

/* ------------------------------------------------------------ security test */

const ATTACKS: { id: string; icon: IconName; title: string; text: string; fakeOnly?: boolean }[] = [
  { id: "redirect", icon: "send", title: "Redirect", text: "Pay attacker.demo instead of the payee" },
  { id: "overpay", icon: "coins", title: "Overpay", text: "Pay $1 more than the per-payment cap" },
  { id: "injected", icon: "bot", title: "Prompt injection", text: "A PR talks the judge into an in-cap payout" },
  { id: "after_end", icon: "calendar", title: "After the end", text: "Request a payout once the job ended", fakeOnly: true },
];

function SecurityTab({ c, config, act }: { c: ContractView; config: AppConfig; act: Act }) {
  const attacks = ATTACKS.filter((a) => !a.fakeOnly || config.platform === "fake");
  const [hints, setHints] = useState<Record<string, string>>({});
  const latest = (id: string) => c.payouts.find((p) => p.kind === "attack" && p.request_id.startsWith(`atk-${id}-`));
  // An attack that can't run yet (e.g. after the end, before the end date) answers { ready: false, hint }.
  const fire = async (id: string) => {
    const r = await api<{ ready?: boolean; hint?: string }>("POST", `/contracts/${c.id}/attacks/${id}`);
    setHints((h) => ({ ...h, [id]: r.ready === false ? (r.hint ?? "Not ready yet.") : "" }));
  };
  const run = (id: string) => act(() => fire(id));
  const runAll = () =>
    act(async () => {
      for (const a of attacks) await fire(a.id);
    });

  return (
    <Card>
      <CardHeader
        icon="shield"
        title="Compromised-server test"
        sub="Real payout requests with Paperwork's own checks skipped. The platform's policy and your approval are what stop them."
        actions={
          <Button icon="zap" onClick={runAll} disabled={c.stage !== "active" && c.stage !== "ended"}>
            Run all
          </Button>
        }
      />
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
                <Button size="sm" variant="secondary" onClick={() => run(a.id)} disabled={c.stage !== "active" && c.stage !== "ended"}>
                  Run
                </Button>
              </div>
              {hints[a.id] ? (
                <div className="attack-note">
                  <Icon name="info" size={14} /> {hints[a.id]}
                </div>
              ) : null}
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
                  {p.state !== "held" && p.state !== "refused" && p.state !== "blocked" && p.state !== "rejected" ? <StateNote p={p} act={act} /> : null}
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

/** Market-settled jobs have no platform agent or policy: the Market holds and releases the awarded price. */
function MarketSettlementCard({ terms }: { terms: MarketTerms }) {
  return (
    <Card>
      <CardHeader icon="wallet" title="Settled on the Agent Market" sub={`Market job ${terms.market_source.job_id}`} />
      <ul className="checks">
        <li className="warn"><Icon name="info" size={14} />The Market pays its awarded price when the agency accepts the work there, or when the Market's acceptance window lapses.</li>
        <li className="warn"><Icon name="info" size={14} />Paperwork reviews the report and invoice against the {terms.scope.length} signed deliverable{terms.scope.length === 1 ? "" : "s"} and requests no payment.</li>
        <li className="warn"><Icon name="info" size={14} />Paperwork can confirm the Market reports the job completed, not that the Market's payout reached the builder.</li>
      </ul>
    </Card>
  );
}

function PolicyTab({ c, verify }: { c: ContractView; verify: VerifyView | null }) {
  return (
    <div className="split even">
      <div className="stack">
        {isMarketSettled(c.terms) ? <MarketSettlementCard terms={c.terms} /> : <PolicyCard
          payee={c.terms.payee.address}
          scope={c.terms.scope}
          start={c.terms.start}
          end={c.terms.end}
          payUntil={payoutEndInstant(c.terms).slice(0, 10)}
          repos={c.terms.repos}
          approver={c.terms.v === 3 && c.terms.agency_owner ? c.terms.agency_owner.account_id : c.terms.representative.near_account}
          status={c.stage === "frozen" ? "frozen" : c.stage === "ended" ? "ended" : "live"}
          agentId={c.platform.agent_id}
          standIn={c.platform.mode === "fake"}
          reportWorkflow={c.terms.v === 3}
          capAtScope={capsAtScope(c.terms)}
        />}
      </div>
      <Card>
        <CardHeader
          icon="shieldCheck"
          title="Verification"
          sub={isMarketSettled(c.terms) ? "The signed terms and the awarded Market job" : "The platform's policy against the signed terms"}
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
          <p className="muted">{isMarketSettled(c.terms) ? "Loading verification." : "Available once the agent exists."}</p>
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
  const after = new Date(Date.parse(payoutEndInstant(c.terms)) + 12 * 3600_000).toISOString();
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
      {c.terms.v === 2 ? <button
        className="simbar-btn"
        onClick={async () => {
          await api("POST", "/sim/merge", { contract_id: c.id });
          await api("POST", `/contracts/${c.id}/run`).catch(() => undefined);
          await reload();
        }}
      >
        <Icon name="pr" size={13} /> Simulate a merge
      </button> : null}
      <button className="simbar-btn" disabled={!settling} onClick={() => post("/sim/settle", { contract_id: c.id })}>
        <Icon name="send" size={13} /> Settle approved payouts
      </button>
      <button className="simbar-btn" onClick={() => post("/sim/advance", { to: after })}>
        <Icon name="fastForward" size={13} /> Jump past end date
      </button>
    </div>
  );
}

/** The platform's wallet stop page, where the owner freezes the agent with their own wallet (platform 0.5.5 and later). */
function walletStopUrl(c: ContractView): string {
  return `https://${c.platform.host}/confirm/wallet/stop/${encodeURIComponent(c.platform.agent ?? "")}`;
}
