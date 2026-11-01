import { useCallback, useEffect, useState } from "react";
import { api, links, ownerAction, signMessage } from "../api";
import { Icon, type IconName } from "../components/icons";
import { PolicyCard } from "../components/PolicyCard";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  dateText,
  Empty,
  Json,
  Mono,
  PageLoading,
  Progress,
  short,
  Stat,
  Tabs,
  timeText,
  type Tone,
  usd,
} from "../components/ui";
import { PHASES, SETUP, type StepId } from "../guide";
import type { AppConfig, AttackResult, ContractView, Payout, VerifyReport } from "../types";
import { STAGES } from "./Home";

type Act = (fn: () => Promise<unknown>) => Promise<void>;

export function ContractPage({ id, config }: { id: string; config: AppConfig }) {
  const [c, setC] = useState<ContractView | null>(null);
  const [verify, setVerify] = useState<VerifyReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api<ContractView>("GET", `/contracts/${id}`);
      setC(next);
      setVerify(next.grant ? await api<VerifyReport>("GET", `/contracts/${id}/verify`) : null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!c?.payouts.some((p) => p.status === "queued")) return;
    const t = setInterval(() => void load(), 5000);
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

  const setup = c.stage.startsWith("needs_");
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
                {c.terms.company} · {usd(c.terms.rate_per_accepted_pr_usd)} per PR · up to {usd(c.terms.monthly_cap_usd)}/mo
              </p>
            </div>
            <Badge tone={stage.tone} dot>
              {stage.label}
            </Badge>
          </div>
        </div>
        <div className="header-actions">
          <Mono copy={c.hash}>{`terms ${short(c.hash, 6, 4)}`}</Mono>
          {c.grant ? <Mono copy={verifyLink}>Copy verify link</Mono> : null}
          {c.agent && !c.agent.frozen && c.stage !== "ended" ? (
            <Button
              variant="ghost"
              size="sm"
              icon="snowflake"
              onClick={() => {
                if (window.confirm("Freeze this contract wallet? It will not be able to pay anything again.")) return act(() => ownerAction(config.provider, c.id, "agent_freeze"));
              }}
            >
              Freeze
            </Button>
          ) : null}
        </div>
      </header>

      {config.provider === "sim" ? <SimBar c={c} config={config} reload={load} /> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {setup ? <Setup c={c} config={config} act={act} /> : <Dashboard c={c} config={config} verify={verify} act={act} reload={load} />}
    </div>
  );
}

/* ------------------------------------------------------------------ setup */

function stepDone(c: ContractView, s: StepId): boolean {
  switch (s) {
    case "rep-sign":
      return !!c.signatures.representative;
    case "contractor-sign":
      return !!c.signatures.contractor;
    case "wallet":
      return !!c.agent;
    case "grant":
      return !!c.grant;
    case "fund":
      return !!c.agent && Number(c.agent.available_usd) > 0;
  }
}

function Setup({ c, config, act }: { c: ContractView; config: AppConfig; act: Act }) {
  const current = SETUP.find((s) => !stepDone(c, s.id))?.id;
  const currentPhase = SETUP.find((s) => s.id === current)?.phase ?? "live";
  const doneCount = SETUP.filter((s) => stepDone(c, s.id)).length;

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
              <SetupRow key={s.id} step={s} c={c} config={config} act={act} state={stepDone(c, s.id) ? "done" : s.id === current ? "current" : "todo"} />
            ))}
          </ol>
        </Card>
      </div>

      <aside className="split-side">
        <div className="sticky">
          <div className="side-label">Wallet policy</div>
          <PolicyCard
            payee={c.terms.payee.address}
            cap={c.terms.monthly_cap_usd}
            rate={c.terms.rate_per_accepted_pr_usd}
            start={c.terms.start}
            end={c.terms.end}
            repos={c.terms.repos}
            timelockMinutes={Math.round(c.compiled.policy.timelock_ms / 60000)}
            status={c.agent ? "live" : "draft"}
            agentId={c.agent?.agent_id}
          />
          <Json value={c.compiled} label="Compiled policy" />
        </div>
      </aside>
    </div>
  );
}

function SetupRow({ step, c, config, act, state }: { step: (typeof SETUP)[number]; c: ContractView; config: AppConfig; act: Act; state: "done" | "current" | "todo" }) {
  const [help, setHelp] = useState(false);
  const sim = config.provider === "sim";
  const n = SETUP.findIndex((s) => s.id === step.id) + 1;

  const detail = (() => {
    if (state !== "done") return step.short;
    switch (step.id) {
      case "rep-sign":
        return `Signed by ${c.signatures.representative!.account_id} · ${timeText(c.signatures.representative!.signed_at)}`;
      case "contractor-sign":
        return `Signed by ${c.signatures.contractor!.account_id} · ${timeText(c.signatures.contractor!.signed_at)}`;
      case "wallet":
        return `Agent ${c.agent!.agent_id}`;
      case "grant":
        return `Expires ${timeText(c.grant!.expires_at)}`;
      case "fund":
        return `Balance ${usd(c.agent!.available_usd)}`;
    }
  })();

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
        {state === "current" ? <StepAction step={step.id} c={c} sim={sim} config={config} act={act} /> : null}
      </div>
    </li>
  );
}

function StepAction({ step, c, sim, config, act }: { step: StepId; c: ContractView; sim: boolean; config: AppConfig; act: Act }) {
  const [amount, setAmount] = useState(String(Math.ceil(Number(c.terms.monthly_cap_usd) * 1.2)));
  const token = links.get(c.id);

  const signTerms = (role: "representative" | "contractor") =>
    act(async () => {
      const req = await api("GET", `/contracts/${c.id}/signing-request?role=${role}`);
      const s = await signMessage(config.provider, req);
      await api("POST", `/contracts/${c.id}/signatures`, { role, signed: s, contractor_token: token });
    });

  switch (step) {
    case "rep-sign":
      return (
        <div className="check-action">
          <code className="mono message">Covenant work order sha256:{short(c.hash, 10, 6)}</code>
          <Button icon="pen" onClick={() => signTerms("representative")}>
            {sim ? `Sign as ${c.terms.representative.near_account}` : "Sign with wallet"}
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
          {sim && token ? (
            <Button variant="secondary" icon="pen" onClick={() => signTerms("contractor")}>
              Sign as {c.terms.contractor.near_account} (demo shortcut)
            </Button>
          ) : null}
        </div>
      );
    }
    case "wallet":
      return (
        <div className="check-action">
          <Button icon="wallet" onClick={() => act(() => ownerAction(config.provider, c.id, "agent_create"))}>
            {sim ? "Create wallet (demo wallet signs)" : "Create wallet"}
          </Button>
        </div>
      );
    case "grant":
      return (
        <div className="check-action">
          <span className="muted small">Expires {timeText(c.compiled.grant.expires_at)}</span>
          <Button icon="key" onClick={() => act(() => ownerAction(config.provider, c.id, "grant_issue"))}>
            {sim ? "Issue grant (demo wallet signs)" : "Issue grant"}
          </Button>
        </div>
      );
    case "fund":
      return sim ? (
        <div className="check-action">
          <div className="input-affix prefix compact">
            <span>$</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount in USDC" />
          </div>
          <Button icon="coins" onClick={() => act(() => api("POST", "/sim/fund", { agent_id: c.agent!.agent_id, usd: amount }))}>
            Deposit (simulated)
          </Button>
        </div>
      ) : (
        <div className="check-action">
          <Mono copy={c.agent!.deposit_address}>{short(c.agent!.deposit_address, 10, 6)}</Mono>
          <span className="muted small">Send USDC on NEAR to this address.</span>
        </div>
      );
  }
}

/* -------------------------------------------------------------- dashboard */

type TabId = "payouts" | "security" | "policy" | "activity";

function Dashboard({ c, config, verify, act, reload }: { c: ContractView; config: AppConfig; verify: VerifyReport | null; act: Act; reload: () => Promise<void> }) {
  const [tab, setTab] = useState<TabId>("payouts");
  const cap = Number(c.terms.monthly_cap_usd);
  const used = cap - Number(c.remaining_cap_usd);
  const daysLeft = Math.ceil((Date.parse(`${c.terms.end}T23:59:59Z`) - Date.parse(c.now)) / 86_400_000);
  const queued = c.payouts.find((p) => p.status === "queued");

  return (
    <>
      {c.stage === "frozen" ? <Alert tone="danger" icon="snowflake">This wallet is frozen. It can't pay anything.</Alert> : null}
      {c.stage === "ended" ? <Alert tone="info" icon="calendar">This contract ended on {dateText(c.terms.end)}. The agent's permission has expired.</Alert> : null}

      <div className="stats-row four">
        <Stat label="Wallet balance" icon="wallet" value={usd(c.agent?.available_usd ?? "0")} sub="USDC" />
        <Stat label="Used this month" icon="coins" value={usd(used)} sub={`of ${usd(cap)} limit`}>
          <Progress value={used} max={cap} tone={used >= cap ? "warning" : "accent"} />
        </Stat>
        <Stat label="Contract ends" icon="calendar" value={dateText(c.terms.end)} sub={daysLeft > 0 ? `${daysLeft} days left` : "Ended"} />
        <Stat label="Next payout" icon="clock" value={queued ? usd(queued.amount_usd) : "—"} sub={queued ? `dispatches ${timeText(queued.dispatch_at)}` : "Run the agent at period end"} />
      </div>

      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        items={[
          { id: "payouts", label: "Payouts", icon: "coins", count: c.payouts.length },
          { id: "security", label: "Security test", icon: "shield" },
          { id: "policy", label: "Policy & verify", icon: "shieldCheck" },
          { id: "activity", label: "Activity", icon: "activity" },
        ]}
      />

      {tab === "payouts" ? <PayoutsTab c={c} config={config} act={act} /> : null}
      {tab === "security" ? <SecurityTab c={c} config={config} reload={reload} /> : null}
      {tab === "policy" ? <PolicyTab c={c} verify={verify} /> : null}
      {tab === "activity" ? <ActivityTab c={c} /> : null}
    </>
  );
}

const PAYOUT_STATUS: Record<Payout["status"], { label: string; tone: Tone }> = {
  paid: { label: "Paid", tone: "success" },
  queued: { label: "In timelock", tone: "info" },
  persisted: { label: "Sending", tone: "info" },
  escalated: { label: "Needs review", tone: "warning" },
  rejected: { label: "Rejected", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  refused: { label: "Refused by NEAR", tone: "danger" },
  failed: { label: "Failed", tone: "danger" },
  needs_review: { label: "Outcome unknown", tone: "danger" },
};

function PayoutsTab({ c, config, act }: { c: ContractView; config: AppConfig; act: Act }) {
  const canRun = c.stage === "active";
  return (
    <Card pad={false}>
      <div className="card-pad-x">
        <CardHeader
          title="Payouts"
          sub={`Period ${c.period.month} · ${usd(c.remaining_cap_usd)} left under the limit`}
          actions={
            <Button icon="play" disabled={!canRun} onClick={() => act(() => api("POST", `/contracts/${c.id}/run`))}>
              Run agent
            </Button>
          }
        />
      </div>
      {c.payouts.length === 0 ? (
        <Empty icon="bot" title="No payouts yet" sub="The agent reviews merged PRs for this period and pays inside the limits." />
      ) : (
        <ul className="payouts">
          {c.payouts.map((p) => (
            <PayoutItem key={p.id} p={p} c={c} config={config} act={act} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function PayoutItem({ p, c, config, act }: { p: Payout; c: ContractView; config: AppConfig; act: Act }) {
  const [open, setOpen] = useState(p.status === "escalated" || p.status === "queued");
  const accepted = p.score.prs.filter((x) => x.accepted).length;
  const rejected = p.score.prs.length - accepted;
  const st = PAYOUT_STATUS[p.status];
  const total = c.compiled.policy.timelock_ms;
  const left = p.dispatch_at ? Math.max(0, Date.parse(p.dispatch_at) - Date.parse(c.now)) : 0;

  return (
    <li className="payout">
      <button className="payout-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="payout-amount num">{usd(p.amount_usd)}</span>
        <span className="payout-meta">
          <span className="pill-mini ok">
            <Icon name="check" size={12} /> {accepted} accepted
          </span>
          {rejected ? (
            <span className="pill-mini">
              <Icon name="x" size={12} /> {rejected} not counted
            </span>
          ) : null}
          <span className="muted small hide-sm">{timeText(p.created_at)}</span>
        </span>
        <Badge tone={st.tone} dot>
          {st.label}
        </Badge>
        <Icon name="chevronRight" className={`chev-rot${open ? " is-open" : ""}`} />
      </button>

      {p.status === "queued" ? (
        <div className="timelock">
          <div className="timelock-text">
            <Icon name="clock" size={14} /> Dispatches {timeText(p.dispatch_at)} unless you cancel
          </div>
          <Progress value={total - left} max={total} />
          <Button variant="danger" size="sm" icon="ban" onClick={() => act(() => ownerAction(config.provider, c.id, "execution_cancel", p.id))}>
            Cancel payout
          </Button>
        </div>
      ) : null}

      {p.status === "escalated" ? (
        <div className="escalation">
          <Icon name="alert" size={16} />
          <span>{p.score.summary} Flagged PRs stay excluded.</span>
          <Button size="sm" icon="check" onClick={() => act(() => api("POST", `/payouts/${p.id}/approve`))}>
            Approve {usd(p.amount_usd)}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => act(() => api("POST", `/payouts/${p.id}/reject`))}>
            Reject
          </Button>
        </div>
      ) : null}

      {open ? (
        <div className="payout-detail">
          <ul className="prs">
            {p.score.prs.map((pr) => (
              <li key={pr.key} className={pr.accepted ? "ok" : pr.flags.length ? "warn" : "no"}>
                <Icon name={pr.accepted ? "check" : pr.flags.length ? "alert" : "x"} size={14} />
                <a href={pr.url} target="_blank" rel="noreferrer" className="pr-key">
                  {pr.key}
                </a>
                <span className="pr-title">{pr.title}</span>
                {!pr.accepted ? <span className="pr-reason">{pr.reason}</span> : null}
              </li>
            ))}
          </ul>
          {p.tx_hash ? (
            <div className="kv-line">
              <span>Transaction</span>
              <Mono copy={p.tx_hash}>{short(p.tx_hash, 14, 6)}</Mono>
            </div>
          ) : null}
          {p.error ? <Json value={p.error} label="Provider response" /> : null}
        </div>
      ) : null}
    </li>
  );
}

const ATTACKS: { id: string; icon: IconName; title: string; text: string }[] = [
  { id: "overpay", icon: "coins", title: "Overpay", text: "Pay $1 more than the limit" },
  { id: "redirect", icon: "send", title: "Redirect", text: "Pay attacker.near instead" },
  { id: "injected", icon: "bot", title: "Prompt injection", text: "A PR tricks the AI into $5,000" },
  { id: "after_end", icon: "calendar", title: "After the end", text: "Pay after the contract ended" },
];

function SecurityTab({ c, config, reload }: { c: ContractView; config: AppConfig; reload: () => Promise<void> }) {
  const [results, setResults] = useState<Record<string, AttackResult>>({});
  const [mode, setMode] = useState<"dry" | "live">("dry");
  const [error, setError] = useState<string | null>(null);

  const run = async (id: string) => {
    setError(null);
    try {
      const r = await api<AttackResult>("POST", `/contracts/${c.id}/attacks/${id}?mode=${mode}`);
      setResults((x) => ({ ...x, [id]: r }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const runAll = async () => {
    for (const a of ATTACKS) await run(a.id);
    await reload();
  };

  return (
    <Card>
      <CardHeader
        icon="shield"
        title="Compromised-server test"
        sub="Covenant's own checks are off. Each request goes straight to NEAR with the agent's real grant."
        actions={
          <>
            {config.provider === "sim" ? (
              <div className="segmented" role="radiogroup" aria-label="Mode">
                <button className={mode === "dry" ? "is-active" : ""} onClick={() => setMode("dry")} role="radio" aria-checked={mode === "dry"}>
                  Dry run
                </button>
                <button className={mode === "live" ? "is-active" : ""} onClick={() => setMode("live")} role="radio" aria-checked={mode === "live"}>
                  Send
                </button>
              </div>
            ) : null}
            <Button icon="zap" onClick={runAll} disabled={!c.grant}>
              Run all
            </Button>
          </>
        }
      />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="attacks">
        {ATTACKS.map((a) => {
          const r = results[a.id];
          const blocked = r?.outcome && r.outcome !== "allowed";
          return (
            <div key={a.id} className={`attack${r?.outcome ? (blocked ? " is-blocked" : " is-allowed") : ""}`}>
              <div className="attack-top">
                <span className="icon-tile">
                  <Icon name={a.icon} />
                </span>
                <div className="attack-copy">
                  <h3>{a.title}</h3>
                  <p>{a.text}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => run(a.id)} disabled={!c.grant}>
                  Run
                </Button>
              </div>
              {r && !r.ready ? <div className="attack-note"><Icon name="info" size={14} /> {r.hint}</div> : null}
              {r?.outcome ? (
                <div className="attack-result">
                  <div className="attack-verdict">
                    <Icon name={blocked ? "shieldCheck" : "shieldX"} size={18} />
                    {blocked ? (r.outcome === "refused" ? "Blocked by NEAR" : "Would be blocked") : "Not blocked"}
                  </div>
                  <div className="chips">
                    {r.findings?.slice(0, 2).map((f) => (
                      <span key={f.code} className="chip" title={f.clause.text}>
                        <Icon name="lock" size={12} /> {f.clause.title.replace(" clause", "")} · <code>{f.code}</code>
                      </span>
                    ))}
                    {(r.findings?.length ?? 0) > 2 ? <span className="chip muted">+{r.findings!.length - 2} more</span> : null}
                  </div>
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

function PolicyTab({ c, verify }: { c: ContractView; verify: VerifyReport | null }) {
  return (
    <div className="split even">
      <div className="stack">
        <PolicyCard
          payee={c.terms.payee.address}
          cap={c.terms.monthly_cap_usd}
          rate={c.terms.rate_per_accepted_pr_usd}
          start={c.terms.start}
          end={c.terms.end}
          repos={c.terms.repos}
          timelockMinutes={Math.round(c.compiled.policy.timelock_ms / 60000)}
          status={c.stage === "frozen" ? "frozen" : c.stage === "ended" ? "ended" : "live"}
          agentId={c.agent?.agent_id}
        />
        <Json value={c.compiled} label="Compiled policy" />
      </div>
      <Card>
        <CardHeader
          icon="shieldCheck"
          title="Verification"
          sub="The live wallet against the signed terms"
          actions={
            <a className="btn btn-secondary btn-sm" href={`#/c/${c.id}/verify`} target="_blank" rel="noreferrer">
              <Icon name="external" /> <span>Open</span>
            </a>
          }
        />
        {verify ? (
          <ul className="checks">
            {verify.checks.map((x) => (
              <li key={x.id} className={x.ok ? "ok" : x.info ? "warn" : "bad"}>
                <Icon name={x.ok ? "check" : x.info ? "alert" : "x"} size={14} strokeWidth={2.4} />
                {x.label}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Available once the grant is issued.</p>
        )}
      </Card>
    </div>
  );
}

function ActivityTab({ c }: { c: ContractView }) {
  const icon: Record<string, IconName> = {
    draft: "file",
    signed: "pen",
    wallet: "wallet",
    grant: "key",
    run: "bot",
    sent: "send",
    paid: "check",
    cancel: "ban",
    freeze: "snowflake",
    escalate: "alert",
    approve: "check",
    reject: "x",
    refused: "shieldCheck",
    review: "alert",
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

function SimBar({ c, config, reload }: { c: ContractView; config: AppConfig; reload: () => Promise<void> }) {
  const after = new Date(Date.parse(`${c.terms.end}T00:00:00Z`) + 36 * 3600_000).toISOString();
  const go = async (body: unknown) => {
    await api("POST", "/sim/advance", body);
    await reload();
  };
  return (
    <div className="simbar">
      <span className="simbar-label">
        <Icon name="clock" size={14} /> Simulated time <strong>{timeText(c.now)}</strong>
      </span>
      <button className="simbar-btn" onClick={() => go({ ms: config.timelock_ms + 1000 })}>
        <Icon name="fastForward" size={13} /> Skip timelock
      </button>
      <button className="simbar-btn" onClick={() => go({ to: after })}>
        <Icon name="fastForward" size={13} /> Jump past end date
      </button>
    </div>
  );
}
