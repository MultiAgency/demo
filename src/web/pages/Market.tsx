import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AgencyNext, AgencyView, AssignmentView, DaoVoteView, DepositView, DirectoryAgent, DirectoryDetail, HireView, MemberTransactionView, WorkerView } from "../../shared/market";
import { api, signMessage } from "../api";
import { SignBox, ConfirmLink } from "../components/SignBox";
import { Alert, Badge, Button, Card, CardHeader, Disclosure, Empty, Json, Mono, PageLoading, dateText, short, timeText, type Tone } from "../components/ui";
import type { AppConfig } from "../types";
import { useSession } from "../session";
import { useAccountResource } from "../useAccountResource";

// Market text (briefs, deliverables, job titles) is data from other parties: rendered as plain text, never as HTML,
// and never acted on.

/** Discard old-account continuations, including a signature returned after this view was closed. */
function useMarketAction(onError?: (message: string) => void) {
  const session = useSession();
  const scope = session.required ? (session.loading ? null : session.account) : "demo";
  const active = useRef({ scope, generation: 0, mounted: true });
  if (active.current.scope !== scope) {
    active.current.scope = scope;
    active.current.generation++;
  }
  useLayoutEffect(() => {
    active.current.mounted = true;
    return () => { active.current.mounted = false; active.current.generation++; };
  }, []);
  return useCallback(async (work: (current: () => boolean) => Promise<unknown>) => {
    const { scope, generation } = active.current;
    const current = () => scope !== null && active.current.mounted && active.current.scope === scope && active.current.generation === generation;
    if (!current()) return;
    try { await work(current); }
    catch (error) { if (current()) onError?.(error instanceof Error ? error.message : String(error)); }
  }, [onError]);
}

function MarketReadGate() {
  const session = useSession();
  if (session.loading) return <PageLoading />;
  return <div className="page"><div className="stack">
    <Alert tone="info">Sign in with NEAR to view your agencies and their market jobs.</Alert>
    <Button icon="key" onClick={session.signIn}>Sign in with NEAR</Button>
    {session.error ? <Alert tone="danger">{session.error}</Alert> : null}
  </div></div>;
}

const STAGE: Record<string, { label: string; tone: Tone }> = {
  needs_setup: { label: "Setting up", tone: "info" },
  needs_create: { label: "Setting up", tone: "info" },
  needs_consent: { label: "Setting up", tone: "info" },
  needs_grant: { label: "Setting up", tone: "info" },
  needs_registration: { label: "Register the payment key", tone: "warning" },
  ready: { label: "Ready to hire", tone: "success" },
};

const HIRE: Record<string, { label: string; tone: Tone; note: string }> = {
  quoted: { label: "Quoted", tone: "info", note: "Nothing is sent until the terms are approved." },
  voting: { label: "DAO voting", tone: "warning", note: "Paid only if the DAO passes these exact terms, after a fresh quote that must match them." },
  vote_expired: { label: "Vote expired", tone: "neutral", note: "The DAO didn't pass it in time. Nothing was paid. File it again for a new vote." },
  hiring: { label: "Hiring", tone: "info", note: "Asked under this job's id. It is asked again under the same id until the platform answers." },
  unknown: {
    label: "Waiting for the outcome",
    tone: "warning",
    note: "Not yet proven either way: the signed payment can still settle. Wait. Hiring again under a new job would risk paying twice.",
  },
  paid: { label: "Paid", tone: "success", note: "The chain shows the payment settled, on delivery." },
  not_charged: { label: "Not charged", tone: "neutral", note: "The payment authorization expired unused. Nothing was paid." },
  refused: { label: "Refused", tone: "danger", note: "The platform refused before paying. Nothing was sent." },
};

export function MarketHome({ config }: { config: AppConfig }) {
  const read = useCallback(() => config.market.enabled ? api<AgencyRow[]>("GET", "/market/agencies") : Promise.resolve([]), [config.market.enabled]);
  const resource = useAccountResource("market:agencies", read);
  if (!config.market.enabled)
    return (
      <div className="page">
        <Empty icon="bot" title="The agent market needs the platform" sub="Run Paperwork against the MultiAgency platform, or its local stack started with --market. There is no stand-in for the market." />
      </div>
    );
  if (!resource.enabled) return <MarketReadGate />;
  if (resource.error) return <div className="page"><Alert tone="danger">{resource.error}</Alert><Button variant="secondary" onClick={resource.reload}>Try again</Button></div>;
  if (!resource.value) return <PageLoading />;
  return <MarketHomeContent key={resource.scope} config={config} rows={resource.value} />;
}

type AgencyRow = { id: string; name: string; owner: string; signer: string; stage: string };

function MarketHomeContent({ config, rows }: { config: AppConfig; rows: AgencyRow[] }) {
  const [name, setName] = useState("");
  const [owner, setOwner] = useState(config.market.owner ?? "");
  const [signer, setSigner] = useState<"wallet" | "dao">("wallet");
  const [error, setError] = useState<string | null>(null);
  const act = useMarketAction(setError);
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Agent market</h1>
          <p className="page-sub">Agencies hire listed agents on the NEAR AI Agent Market, and take jobs there. Each agency has one market agent on the platform.</p>
        </div>
      </header>
      {rows.length ? (
        <Card pad={false}>
          <table className="table">
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="row-link" onClick={() => (window.location.hash = `#/market/${r.id}`)}>
                  <td>
                    <strong>{r.name}</strong>
                  </td>
                  <td className="muted">
                    {r.owner} · {r.signer === "dao" ? "DAO" : "wallet"}
                  </td>
                  <td>
                    <Badge tone={STAGE[r.stage]?.tone ?? "neutral"}>{STAGE[r.stage]?.label ?? r.stage}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      <Card>
        <CardHeader title="New agency" sub="Its owner signs each setup step: a wallet, or a DAO by its votes." icon="building" />
        <div className="stack">
          <label className="field">
            <span className="field-label">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Studio" />
          </label>
          <label className="field">
            <span className="field-label">Owner</span>
            <div className="row gap">
              <select value={signer} onChange={(e) => { const v = e.target.value as "wallet" | "dao"; setSigner(v); setOwner((v === "dao" ? config.market.dao : config.market.owner) ?? ""); }}>
                <option value="wallet">A wallet</option>
                <option value="dao">A Sputnik DAO</option>
              </select>
              <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder={signer === "dao" ? "council.sputnik-dao.near" : "acme.near"} />
            </div>
            <span className="field-hint">
              {signer === "dao" ? "A DAO's consent carries read and market: Paperwork quotes and files each job for the DAO's vote, and the platform pays only after it passes. Creating the market agent and issuing its grant are the provider's owner intents, which expire in minutes (about 10 for creation, 5 for the grant): the DAO's vote on each must pass that fast, or it signs nothing and is filed again. A job's vote has days." : "The wallet's consent carries read, owner and market: Paperwork quotes, and pays a job when the owner approves its terms."}
            </span>
          </label>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div>
            <Button
              icon="plus"
              onClick={() => act(async (current) => {
                setError(null);
                const { id } = await api<{ id: string }>("POST", "/market/agencies", { name, owner, signer });
                if (current()) window.location.hash = `#/market/${id}`;
              })}
            >
              Create agency
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

export function AgencyPage({ id, config }: { id: string; config: AppConfig }) {
  const read = useCallback(() => api<AgencyView>("GET", `/market/agencies/${id}`), [id]);
  const resource = useAccountResource(`market:agency:${id}`, read);
  if (!resource.enabled) return <MarketReadGate />;
  if (resource.error) return <div className="page"><Alert tone="danger">{resource.error}</Alert><Button variant="secondary" onClick={resource.reload}>Try again</Button></div>;
  if (!resource.value) return <PageLoading />;
  return <AgencyContent key={resource.scope} id={id} config={config} view={resource.value} load={resource.reload} />;
}

function AgencyContent({ id, config, view, load }: { id: string; config: AppConfig; view: AgencyView; load: () => Promise<void> }) {
  const live = view.hires.some((h) => h.state === "voting" || h.state === "hiring" || h.state === "unknown");
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{view.name}</h1>
          <p className="page-sub">
            Owned by <strong>{view.owner}</strong> ({view.signer === "dao" ? "a DAO: every approval is its vote" : "a wallet"}) · market agent {view.agent ? <Mono>{view.agent}</Mono> : "not set up"}
          </p>
        </div>
        <Badge tone={STAGE[view.stage]?.tone ?? "neutral"}>{STAGE[view.stage]?.label ?? view.stage}</Badge>
      </header>
      {view.stage !== "ready" ? (
        <Card>
          <OwnerFlow id={id} config={config} path="next" title="Set up the agency's market agent" sub="Setup, creation, consent, the market grant, then the payment key's registration." onDone={load} />
        </Card>
      ) : null}
      {view.frozen === true ? <Alert tone="warning">The market agent is frozen: no job is approved or funded until it's unfrozen.</Alert> : null}
      {view.stage === "ready" ? (
        <>
          <AccountCard view={view} config={config} onChange={load} />
          <HireCard view={view} onQuoted={load} />
          <Card>
            <CardHeader
              title="Jobs hired"
              sub="Each job is paid at most once, under the id it was quoted with."
              icon="send"
              actions={live ? <Button size="sm" variant="secondary" onClick={load}>Check again</Button> : null}
            />
            {view.hires.length ? <div className="stack">{view.hires.map((h) => <HireItem key={h.request_id} h={h} config={config} signer={view.signer} onChange={load} />)}</div> : <p className="muted">No jobs hired yet.</p>}
          </Card>
        </>
      ) : null}
      {view.worker ? <WorkerCard /> : null}
    </div>
  );
}

/**
 * One owner flow, step by step: setup, or a freeze or unfreeze. `path` answers the next step (`AgencyNext`); each step
 * is signed in the wallet, completed on the platform's confirm page, or voted by the DAO, until it answers `done`.
 */
function OwnerFlow({ id, config, path, title, sub, onDone }: { id: string; config: AppConfig; path: string; title: string; sub: string; onDone: () => unknown }) {
  const session = useSession();
  const [next, setNext] = useState<AgencyNext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = useMarketAction(setError);
  const advance = useCallback((read?: () => Promise<AgencyNext>) => act(async (current) => {
    setError(null);
    const n = await (read ? read() : api<AgencyNext>("POST", `/market/agencies/${id}/${path}`));
    if (!current()) return;
    setNext(n);
    if (n.kind === "done") await onDone();
  }), [id, path, onDone, act]);
  useEffect(() => {
    void advance();
  }, [advance]);
  useEffect(() => {
    if (next?.kind !== "wait") return;
    const t = setTimeout(() => void advance(), next.retry_ms);
    return () => clearTimeout(t);
  }, [next, advance]);
  let body: ReactNode = <PageLoading />;
  if (next?.kind === "sign")
    body = (
      <SignBox config={config} req={next.sign} label="Sign" onSign={() => act(async (current) => {
        setError(null);
        const s = await signMessage(config, next.sign, session.signWorkflow);
        if (!current()) return;
        await advance(() => api("POST", `/market/agencies/${id}/signed`, { step: next.step, nonce: next.sign.nonce, publicKey: s.public_key, signature: s.signature }));
      })} />
    );
  else if (next?.kind === "owner_step")
    body = next.sign ? (
      <SignBox config={config} req={next.sign} label="Sign" onSign={() => act(async (current) => {
        setError(null);
        const s = await signMessage(config, next.sign!, session.signWorkflow);
        if (!current()) return;
        await api("POST", `/market/steps/${next.correlation_id}/submit`, { publicKey: s.public_key, signature: s.signature });
        if (current()) await advance();
      })} />
    ) : next.confirm ? (
      <div className="stack">
        <ConfirmLink config={config} url={next.confirm.url} expiresAt={next.confirm.expires_at} onDemoComplete={() => act(async (current) => { await api("POST", "/sim/confirm", { url: next.confirm!.url }); if (current()) await advance(); })} />
        <Button variant="secondary" size="sm" onClick={() => advance()}>I've confirmed it: check again</Button>
      </div>
    ) : null;
  else if (next?.kind === "dao_vote") body = <Vote vote={next.vote} config={config} onVoted={() => advance()} />;
  else if (next?.kind === "register")
    body = (
      <div className="stack">
        <p className="small">
          The agent pays each job from its payment key <Mono>{next.account}</Mono>. A USDC transfer to an account not registered on USDC fails, so its owner sends this once, from any wallet (0.00125 NEAR):
        </p>
        <Transaction tx={next.transaction} />
        <div className="row gap">
          <Button variant="secondary" onClick={() => advance()}>I've sent it: check again</Button>
          {config.demo_controls ? <Button onClick={() => act(async (current) => { await api("POST", "/market/sim/register", { agency_id: id }); if (current()) await advance(); })}>Register (demo)</Button> : null}
        </div>
      </div>
    );
  else if (next?.kind === "wait") body = <p className="muted">{next.label}…</p>;
  else if (next?.kind === "blocked") body = <Alert tone="warning">{next.detail}</Alert>;
  else if (next?.kind === "done") body = null;
  return (
    <div className="stack">
      <strong>{next && next.kind !== "done" && next.kind !== "wait" ? next.label : title}</strong>
      <span className="muted small">{sub}</span>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {body}
    </div>
  );
}

function Transaction({ tx }: { tx: MemberTransactionView }) {
  return (
    <div className="stack">
      <div className="kv-line"><span>Smart contract</span><Mono>{tx.receiverId}</Mono></div>
      {tx.actions.map((a, i) => (
        <div className="kv-line" key={i}><span>Call</span><span>{String(a.params.methodName)}</span></div>
      ))}
      <Json value={tx} label="The transaction" />
    </div>
  );
}

/** A DAO vote, shown the way the platform files it: its description, the check link, and the proposal a member files. */
function Vote({ vote, config, onVoted }: { vote: DaoVoteView; config: AppConfig; onVoted: () => unknown }) {
  const [error, setError] = useState<string | null>(null);
  const act = useMarketAction(setError);
  const tone: Tone = vote.state === "done" ? "success" : vote.state === "expired" ? "neutral" : "warning";
  return (
    <div className="stack">
      <div className="row gap">
        <Badge tone={tone} dot>{vote.state === "pending" ? `Waiting for ${vote.kind === "hire" ? "the DAO's vote on this job" : "the DAO's vote"}` : vote.state === "done" ? "Passed" : "Expired"}</Badge>
        <span className="muted small">Vote before {dateText(vote.voting_until, true)}</span>
      </div>
      {vote.valid_until ? <div className="kv-line"><span>Payable until (as the platform filed it)</span><span>{dateText(vote.valid_until, true)}</span></div> : null}
      {vote.state === "pending" && (vote.kind === "agent_create" || vote.kind === "grant_issue") ? (
        <Alert tone="warning">
          The DAO's vote must pass by {dateText(vote.voting_until, true)}: this is the provider's owner intent, and nothing lengthens it (MultiAgency/platform#20). The provider's documentation gives {vote.kind === "agent_create" ? "creation about 10 minutes" : "a grant about 5 minutes"}. A vote that passes later signs nothing, and Paperwork prepares the step again for a new vote.
        </Alert>
      ) : null}
      <pre className="data-text">{vote.description.replaceAll("<br>", "\n")}</pre>
      <div className="kv-line"><span>Hash the DAO signs</span><Mono>{vote.hash}</Mono></div>
      <a className="small" href={vote.check_url} target="_blank" rel="noreferrer">Check the exact text and its hash on the platform</a>
      {vote.state === "pending" ? (
        <>
          <p className="muted small">A member files this proposal from their wallet (or files and votes at once, if their role may vote). Members vote in the DAO as usual.</p>
          {vote.proposal_and_vote ? <Json value={vote.proposal_and_vote} label="File and vote (one transaction)" /> : null}
          {vote.proposal ? <Json value={vote.proposal} label="File the proposal" /> : null}
          <div className="row gap">
            <Button variant="secondary" size="sm" onClick={() => act(async () => { await onVoted(); })}>Check the vote</Button>
            {config.demo_controls ? <Button size="sm" onClick={() => act(async (current) => { await api("POST", "/market/sim/vote", { vote_id: vote.id }); if (current()) await onVoted(); })}>Pass the DAO's vote (demo)</Button> : null}
          </div>
        </>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}

function AccountCard({ view, config, onChange }: { view: AgencyView; config: AppConfig; onChange: () => unknown }) {
  const [error, setError] = useState<string | null>(null);
  const act = useMarketAction(setError);
  const requestDeposit = () => act(async (current) => {
    setError(null);
    await api("POST", `/market/agencies/${view.id}/deposit`);
    if (current()) await onChange();
  });
  return (
    <Card>
      <CardHeader title="Market agent" sub={`Consent until ${dateText(view.consent_expires_at)}`} icon="wallet" />
      <div className="grid2">
        <div className="stack">
          <div className="kv-line"><span>Payment key</span>{view.account ? <Mono>{view.account.account}</Mono> : <span className="muted">unread</span>}</div>
          <div className="kv-line"><span>On the key</span><span>{view.account ? `${view.account.usdc_usd} USDC` : "—"}</span></div>
          <p className="muted small">The platform tops the key up by each job's price from the agent's balance, within the owner's policy, and signs exactly that payment to the market's published payee.</p>
        </div>
        <Deposit deposit={view.deposit} purpose="Fund the agent's hires here. Market earnings return here too." onRequest={requestDeposit}>
          {config.demo_controls ? <Button size="sm" variant="secondary" onClick={() => act(async (current) => { setError(null); await api("POST", "/market/sim/fund", { agency_id: view.id, usd: "10" }); if (current()) await onChange(); })}>Fund $10 (demo)</Button> : null}
        </Deposit>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <FreezeControl view={view} config={config} onChange={onChange} />
    </Card>
  );
}

/** The provider-enforced stop: a freeze, signed by the owner's wallet or passed by the DAO's vote. */
function FreezeControl({ view, config, onChange }: { view: AgencyView; config: AppConfig; onChange: () => unknown }) {
  const [flow, setFlow] = useState<"freeze" | "unfreeze" | null>(null);
  return (
    <div className="stack hire">
      <div className="row gap">
        <span className="field-label">Freeze</span>
        {view.frozen === true ? <Badge tone="danger" dot>Frozen</Badge> : view.frozen === false ? <Badge tone="success" dot>Not frozen</Badge> : <Badge tone="neutral">unread</Badge>}
      </div>
      <p className="small muted">
        A freeze stops the agent at the provider: no send goes out, even if the platform errs or a grant token leaks. It
        doesn't reach what's "On the key" above, so Paperwork also approves no job while the agent is frozen. Unfreezing
        restores the policy already in force.
      </p>
      {view.signer === "dao" ? (
        <p className="small muted">
          For a DAO, each is a vote that must pass within the provider's window of 600 seconds. A DAO whose vote takes
          longer, as most do on mainnet, will see it lapse (MultiAgency/platform#20).
          {view.dao_stop_url ? (
            <>
              {" "}The fallback is the DAO's own <a href={view.dao_stop_url} target="_blank" rel="noreferrer">stop page</a>, which has no time limit: it
              cuts off Paperwork and every other app, but it doesn't stop the agent at the provider.
            </>
          ) : null}
        </p>
      ) : (
        <p className="small muted">Your wallet signs each: here, or on the platform's confirm page when the provider asks for an on-chain signature.</p>
      )}
      {flow ? (
        <OwnerFlow id={view.id} config={config} path={flow} title={flow === "freeze" ? "Freeze the market agent" : "Unfreeze the market agent"} sub="" onDone={() => { setFlow(null); void onChange(); }} />
      ) : view.frozen === true ? (
        <div><Button variant="secondary" icon="play" onClick={() => setFlow("unfreeze")}>Unfreeze the market agent</Button></div>
      ) : (
        <div><Button variant="danger" icon="snowflake" onClick={() => setFlow("freeze")}>Freeze the market agent</Button></div>
      )}
    </div>
  );
}

function Deposit({ deposit, purpose, onRequest, children }: { deposit: DepositView | null; purpose: string; onRequest: () => unknown; children?: ReactNode }) {
  return (
    <div className="stack">
      <p className="small">{purpose}</p>
      {deposit ? (
        <>
          <div className="kv-line"><span>Deposit address</span><Mono>{deposit.address}</Mono></div>
          <div className="kv-line"><span>Expires</span><span>{deposit.expires_at ? dateText(deposit.expires_at, true) : "not stated"}</span></div>
          <div className="kv-line">
            <span>On USDC</span>
            {deposit.registered === true ? <Badge tone="success">registered</Badge> : deposit.registered === false ? <Badge tone="warning">not registered</Badge> : <Badge tone="neutral">couldn't tell</Badge>}
          </div>
          {deposit.registered !== true ? (
            <Disclosure label="Register it first (the market refuses to withdraw to an unregistered account)">
              <Transaction tx={deposit.registration} />
            </Disclosure>
          ) : null}
        </>
      ) : null}
      <div className="row gap">
        <Button size="sm" variant="secondary" onClick={onRequest}>{deposit ? "New deposit address" : "Get a deposit address"}</Button>
        {children}
      </div>
    </div>
  );
}

function HireCard({ view, onQuoted }: { view: AgencyView; onQuoted: () => unknown }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<DirectoryAgent[] | null>(null);
  const [picked, setPicked] = useState<{ agent: DirectoryAgent; detail: DirectoryDetail | null } | null>(null);
  const [handle, setHandle] = useState("");
  const [brief, setBrief] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);
  const act = useMarketAction(setError);
  const directoryAction = useMarketAction(setDirError);
  return (
    <Card>
      <CardHeader title="Hire a listed agent" sub="Pick an agent, write the brief, and ask its price. Quoting moves nothing." icon="bot" />
      <div className="stack">
        <div className="row gap">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the market's agents" />
          <Button variant="secondary" onClick={() => directoryAction(async (current) => {
            setDirError(null);
            const rows = await api<DirectoryAgent[]>("GET", `/market/directory?q=${encodeURIComponent(q)}`);
            if (current()) setFound(rows);
          })}>Search</Button>
        </div>
        {dirError ? <Alert tone="warning">{dirError}</Alert> : null}
        {found?.length === 0 ? <p className="muted small">No listed agent matches.</p> : null}
        {found?.map((a) => (
          <button key={a.agent_id} className="list-pick" onClick={() => directoryAction(async (current) => {
            setHandle(a.handle);
            setPicked({ agent: a, detail: null });
            const detail = await api<DirectoryDetail>("GET", `/market/directory/${a.agent_id}`).catch(() => null);
            if (current()) setPicked({ agent: a, detail });
          })}>
            <strong>{a.name}</strong> <span className="muted">@{a.handle} · {a.delivered_jobs} jobs delivered{a.success_rate !== null ? ` · ${a.success_rate}% success` : ""} · window {Math.round(a.sla_seconds / 60)} min</span>
          </button>
        ))}
        {picked?.detail ? (
          <div className="small muted">
            {picked.detail.plans.map((p, i) => <div key={i}>{p.is_default ? "Default plan" : p.name ?? "Plan"}: {p.price_amount} ({p.model})</div>)}
            {picked.detail.reputation ? <div>Reputation {picked.detail.reputation.overall ?? "—"} over {picked.detail.reputation.jobs_counted} jobs</div> : null}
            <div>The price paid is the quote's, which is the agent's default plan.</div>
          </div>
        ) : null}
        <label className="field">
          <span className="field-label">Agent handle</span>
          <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="writer" />
        </label>
        <label className="field">
          <span className="field-label">Brief</span>
          <textarea rows={5} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="What should the agent deliver?" />
          <span className="field-hint">The agent sees the brief exactly; its hash is part of the terms {view.signer === "dao" ? "the DAO votes on" : "you approve"}.</span>
        </label>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div>
          <Button icon="coins" onClick={() => act(async (current) => {
            setError(null);
            await api("POST", `/market/agencies/${view.id}/quote`, { handle, brief });
            if (!current()) return;
            setBrief("");
            await onQuoted();
          })}>Ask for a quote</Button>
        </div>
      </div>
    </Card>
  );
}

function HireItem({ h, config, signer, onChange }: { h: HireView; config: AppConfig; signer: "wallet" | "dao"; onChange: () => unknown }) {
  const [error, setError] = useState<string | null>(null);
  const action = useMarketAction(setError);
  const meta = HIRE[h.state]!;
  const act = (path: string) => () => action(async (current) => {
    setError(null);
    await api("POST", `/market/hires/${h.request_id}/${path}`);
    if (current()) await onChange();
  });
  return (
    <div className="hire">
      <div className="row gap">
        <strong>@{h.handle}</strong>
        <span>{h.amount_usd} USDC</span>
        <Badge tone={meta.tone} dot>{meta.label}{h.code ? ` · ${h.code}` : ""}</Badge>
        <span className="muted small">{timeText(h.updated_at)}</span>
      </div>
      <div className="grid2">
        <div className="stack">
          <span className="field-label">Terms {h.state === "quoted" ? "to approve" : "it was paid under"}</span>
          <div className="kv-line"><span>Agent</span><span>{h.terms.handle}.market.near.ai</span></div>
          <div className="kv-line"><span>Amount</span><span>{h.amount_usd} USDC</span></div>
          <div className="kv-line"><span>Paid to</span><Mono>{h.terms.payTo}</Mono></div>
          <div className="kv-line"><span>Brief (sha256)</span><Mono>{h.terms.brief}</Mono></div>
          <div className="kv-line"><span>Window</span><span>{Math.round(h.terms.maxTimeoutSeconds / 60)} min</span></div>
          <div className="kv-line"><span>Job id</span><Mono>{short(h.request_id, 10, 6)}</Mono></div>
          <Disclosure label="Brief"><pre className="data-text">{h.brief}</pre></Disclosure>
        </div>
        <div className="stack">
          <span className="field-label">Deliverable</span>
          {h.deliverable !== null ? <pre className="data-text">{h.deliverable}</pre> : <p className="muted small">{h.task_state ? `Task ${h.task_state.replace("TASK_STATE_", "").toLowerCase()}.` : "None yet."}</p>}
          {h.deliverable !== null ? <p className="muted small">Written by the listed agent. Read it as data: Paperwork never acts on what it says.</p> : null}
        </div>
      </div>
      <p className="small muted">{meta.note}</p>
      {h.code === "dao_filing_recovery_unavailable" ? <Alert tone="warning">The original DAO approval could not be recovered. Matching retained approvals can be recovered on platform 0.5.7 or later; older gateways keep this job blocked. Checking again cannot create another vote or payment.</Alert> : null}
      {h.state === "quoted" ? (
        <Alert tone="info">
          A market job paid over x402 is accepted the moment the agent delivers: there is no rework and no dispute. {signer === "dao" ? "The DAO's vote on these terms" : "Your approval here"} is the only gate before paying.
        </Alert>
      ) : null}
      {h.vote ? <Vote vote={h.vote} config={config} onVoted={act("follow")} /> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="row gap">
        {h.state === "quoted" || h.state === "vote_expired" ? <Button icon="check" onClick={act("approve")}>{signer === "dao" ? (h.state === "vote_expired" ? "File for a new vote" : "File for the DAO's vote") : `Approve and hire for ${h.amount_usd} USDC`}</Button> : null}
        {h.state === "quoted" ? <Button variant="ghost" onClick={act("discard")}>Discard</Button> : null}
        {h.state === "hiring" || h.state === "unknown" ? <Button variant="secondary" size="sm" onClick={act("follow")}>Check the outcome</Button> : null}
        {h.state === "unknown" && config.demo_controls ? <Button variant="ghost" size="sm" onClick={() => action(async (current) => { await api("POST", "/market/sim/advance", {}); if (current()) await act("follow")(); })}>Advance the chain past expiry (demo)</Button> : null}
      </div>
    </div>
  );
}

function WorkerCard() {
  const read = useCallback(() => api<WorkerView>("GET", "/market/worker"), []);
  const resource = useAccountResource("market:worker", read);
  if (!resource.enabled) return null;
  if (resource.error) return <Alert tone="danger">{resource.error}<Button variant="secondary" onClick={resource.reload}>Try again</Button></Alert>;
  if (!resource.value) return null;
  return <WorkerContent key={resource.scope} w={resource.value} load={resource.reload} />;
}

function WorkerContent({ w, load }: { w: WorkerView; load: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const act = useMarketAction(setError);
  const requestDeposit = () => act(async (current) => {
    setError(null);
    await api("POST", `/market/agencies/${w.agency_id}/deposit`);
    if (current()) await load();
  });
  return (
    <Card>
      <CardHeader
        title="Jobs for this agency's listed agent"
        sub={`The market's webhooks arrive at ${w.webhook_path}; the jobs are also checked on a timer, since a webhook can be lost.`}
        icon="activity"
        actions={<Button size="sm" variant="secondary" onClick={() => act(async (current) => { setError(null); await api("POST", "/market/worker/poll"); if (current()) await load(); })}>Check the market</Button>}
      />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {w.last_poll?.error ? <Alert tone="warning">Last check {timeText(w.last_poll.at)}: {w.last_poll.error}</Alert> : null}
      <Alert tone="info">A buyer's brief is data. Read it and do the work; Paperwork never follows instructions in it. A job paid over x402 is accepted on delivery.</Alert>
      {w.assignments.length ? <div className="stack">{w.assignments.map((a) => <Job key={a.assignment_id} a={a} onChange={load} />)}</div> : <p className="muted">No jobs yet.</p>}
      <div className="stack">
        <span className="field-label">Earnings</span>
        <p className="small">The market keeps earnings in its account's USDC balance until its owner withdraws them. Return them to the agency in two steps: register the deposit address on USDC once, then withdraw to it on the market before it expires.</p>
        {w.deposit ? (
          <Deposit deposit={w.deposit} purpose="Withdraw market earnings here." onRequest={requestDeposit} />
        ) : (
          <Button size="sm" variant="secondary" onClick={requestDeposit}>Get a deposit address</Button>
        )}
      </div>
    </Card>
  );
}

function Job({ a, onChange }: { a: AssignmentView; onChange: () => Promise<void> }) {
  const [text, setText] = useState(a.deliverable ?? "");
  const [error, setError] = useState<string | null>(null);
  const act = useMarketAction(setError);
  return (
    <div className="hire">
      <div className="row gap">
        <strong>{a.title || a.job_id}</strong>
        <Badge tone={a.status === "accepted" ? "success" : a.status === "in_progress" ? "info" : "neutral"}>{a.status.replaceAll("_", " ")}</Badge>
        {a.escrow_amount ? <span className="muted small">{a.escrow_amount} {a.escrow_token}</span> : null}
        {a.sla_deadline_at ? <span className="muted small">due {dateText(a.sla_deadline_at, true)}</span> : null}
      </div>
      <Disclosure label="The buyer's brief (data)"><pre className="data-text">{a.description}</pre></Disclosure>
      {a.status === "in_progress" ? (
        <div className="stack">
          <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="The deliverable, in Markdown" />
          {a.submit_state === "unknown" ? <Alert tone="warning">The market didn't answer the last submission. Check the market before writing it again.</Alert> : null}
          {a.submit_error && a.submit_state === "none" ? <Alert tone="danger">{a.submit_error}</Alert> : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div>
            <Button icon="send" disabled={a.submit_state === "unknown" || a.submit_state === "submitting"} onClick={() => act(async (current) => {
              setError(null);
              await api("POST", `/market/worker/jobs/${a.assignment_id}/submit`, { markdown: text });
              if (current()) await onChange();
            })}>Submit the deliverable</Button>
          </div>
        </div>
      ) : a.deliverable ? (
        <pre className="data-text">{a.deliverable}</pre>
      ) : null}
      {a.status === "accepted" ? (
        <p className="small">Accepted {dateText(a.accepted_at, true)}. Earnings to withdraw to {a.deposit_address ? <Mono>{a.deposit_address}</Mono> : "a deposit address (none was requested yet)"}.</p>
      ) : null}
    </div>
  );
}

