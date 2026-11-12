import { DaoProposal } from "./DaoProposal";
import { useState } from "react";
import { jobSubmissionSchema, type JobSubmissionView } from "../../shared/jobs";
import { api, ApiError, prepareVote, submitVote } from "../api";
import type { AppConfig, ContractView, PayoutView, VoteAnswer } from "../types";
import { SignInGate } from "./Account";
import { type Act, ApprovalCard, ATTEMPT, StateNote } from "./Payouts";
import { SignBox } from "./SignBox";
import { ReviewAssistant } from "./ReviewAssistant";
import { Alert, Badge, Button, Card, CardHeader, Disclosure, Mono, timeText, type Tone, usd } from "./ui";
import { useSession } from "../session";

const STATES: Record<JobSubmissionView["state"], { label: string; tone: Tone }> = {
  submitted: { label: "Submitted · awaiting proposal", tone: "info" },
  proposed: { label: "Compensation proposed", tone: "warning" },
  changes_pending: { label: "Changes · cancellation pending", tone: "warning" },
  changes_requested: { label: "Changes requested", tone: "info" },
  settled: { label: "Payment complete", tone: "success" },
  closed: { label: "Review closed", tone: "neutral" },
  disputed: { label: "Disputed · awaiting evidence", tone: "warning" },
};

function ProposalMethod({ config }: { config: AppConfig }) {
  return <p className="small muted">{config.judge.kind === "rules"
    ? "Rule-based demo: a linked evidence reference counts as completion. References do not verify quality; the agency must inspect the work before approval."
    : "The agent assesses the report and evidence descriptions against the acceptance criteria. The agency reviews the work and approves payment explicitly."}</p>;
}

function SubmissionDetails({ s, c }: { s: JobSubmissionView; c: ContractView }) {
  return <div className="stack">
    <div className="job-summary">
      <div><span className="field-hint">Invoice {s.invoice.number}</span><strong>{usd(s.invoice.amount_usd)}</strong></div>
      <div><span className="field-hint">Proposed compensation</span><strong>{usd(s.proposed_usd)}</strong></div>
      <div><span className="field-hint">Paid</span><strong>{usd(s.paid_usd)}</strong></div>
    </div>
    <div className="job-report"><h3>Builder report</h3><p>{s.report}</p></div>
    <div className="job-evidence"><h3>Deliverables and evidence</h3><ul>{s.evidence.map((e, i) => <li key={`${e.deliverable_id}-${i}`}>
      <span className="scope-id">{e.deliverable_id}</span>
      <a href={e.url} target="_blank" rel="noreferrer">{e.label || e.url}</a>
      <span className="small muted">{c.terms.scope.find((d) => d.id === e.deliverable_id)?.title}</span>
    </li>)}</ul></div>
    {s.changes ? <Alert tone="warning"><strong>Agency requested changes.</strong> {s.changes}{s.state === "changes_pending" ? " The current payment must be cancelled before another revision can be submitted." : ""}</Alert> : null}
    <Disclosure label="Record identities">
      <div className="kv-line"><span>Submission</span><Mono copy={s.id}>{s.id}</Mono></div>
      <div className="kv-line"><span>Invoice</span><Mono copy={s.invoice.id}>{s.invoice.id}</Mono></div>
      <div className="kv-line"><span>Accepted terms</span><Mono copy={s.terms_hash}>{s.terms_hash}</Mono></div>
      {s.judgment_id ? <div className="kv-line"><span>Proposal</span><Mono>{s.judgment_id}</Mono></div> : null}
    </Disclosure>
  </div>;
}

function PaymentOutcome({ p }: { p: PayoutView }) {
  const status = ATTEMPT[p.state];
  return <div className="job-payment">
    <div className="row gap"><Badge tone={status.tone}>{p.state === "paid" ? "Confirmed settlement" : p.state === "resolved" && p.resolution === "arrived" ? "Agency marked as arrived" : status.label}</Badge><strong>{usd(p.amount_usd)} to {p.recipient}</strong></div>
    <Mono copy={p.request_id}>{p.request_id}</Mono>
    {p.state === "processing" ? <p className="small muted">Agency approval is recorded. Settlement is still pending.</p> : null}
    {p.state === "paid" && !p.tx_hash ? <p className="small muted">Platform confirmed payment; transaction hash is unavailable.</p> : null}
    {p.state === "unknown" || p.state === "pending" ? <p className="small muted">The outcome is being checked under this payment identity. No replacement payment is created.</p> : null}
    {p.state === "disputed" ? <p className="small muted">Review is closed as disputed. This amount stays committed, is not counted as paid, and the original payment is still checked for evidence.</p> : null}
    {p.tx_hash ? <div className="kv-line"><span>Transaction</span><Mono copy={p.tx_hash}>{p.tx_hash}</Mono></div> : null}
    <Disclosure label="Payment identities">
      <div className="kv-line"><span>Payment request</span><Mono copy={p.request_id}>{p.request_id}</Mono></div>
      {p.payment_correlation_id ? <div className="kv-line"><span>Platform payment</span><Mono copy={p.payment_correlation_id}>{p.payment_correlation_id}</Mono></div> : null}
      {p.approval?.approval_id ? <div className="kv-line"><span>Approval</span><Mono copy={p.approval.approval_id}>{p.approval.approval_id}</Mono></div> : null}
      {p.approval_vote_id ? <div className="kv-line"><span>Approval vote</span><Mono copy={p.approval_vote_id}>{p.approval_vote_id}</Mono></div> : null}
      <div className="kv-line"><span>Agency decision</span><span>{p.vote ?? "No signed decision recorded"}</span></div>
    </Disclosure>
  </div>;
}

function CancelHeld({ p, config, act }: { p: PayoutView; config: AppConfig; act: Act }) {
  const session = useSession();
  const [vote, setVote] = useState<VoteAnswer | null>(null);
  return <div className="stack">
    <Alert tone="warning">Reject the held {usd(p.amount_usd)} payout and sign the cancellation so the builder can revise. A change request alone does not cancel a payment.</Alert>
    <Button variant="secondary" onClick={() => act(async () => {
      const v = await prepareVote(p.request_id, "reject");
      setVote(v);
      if (config.demo_controls) await submitVote(config, v, session.signWorkflow);
    })}>Reject held payout for revision</Button>
    {vote && !config.demo_controls ? vote.dao ? <DaoProposal proposal={vote.dao} onCheck={() => act(() => api("GET", `/owner-steps/${vote.correlation_id}`))} /> : vote.sign ? <SignBox config={config} req={vote.sign} label="Sign rejection" onSign={() => act(() => submitVote(config, vote, session.signWorkflow))} /> : vote.confirm ? <a className="btn btn-primary btn-md" href={vote.confirm.url} target="_blank" rel="noreferrer">Open the platform's confirm page</a> : null : null}
  </div>;
}

export function AgencyJobWorkflow({ c, config, act }: { c: ContractView; config: AppConfig; act: Act }) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const session = useSession();
  const reviewer = session.required ? session.account : "demo";
  const reviewEnabled = config.review?.enabled ?? false;
  return <div className="stack">
    <Card>
      <CardHeader title="Submission and review" sub="Accepted job → builder report and invoice → proposal → agency approval → settlement" />
      <ProposalMethod config={config} />
      {!c.submissions.length ? <p className="job-empty">Waiting for the builder's report, invoice and supporting evidence. Open the builder's private link to submit.</p> : null}
    </Card>
    {c.submissions.map((s) => {
      const status = STATES[s.state];
      const payouts = c.payouts.filter((p) => s.payout_request_ids.includes(p.request_id));
      const reviewable = s.state === "submitted" || (s.state === "proposed" && !payouts.some((p) => p.vote === "approve" || p.state === "processing" || p.state === "paid"));
      return <Card key={s.id}>
        <CardHeader title={`Submission · revision ${s.revision}`} sub={`${s.builder} · ${timeText(s.created_at)}`} actions={<Badge tone={status.tone}>{status.label}</Badge>} />
        <div className="stack">
          <SubmissionDetails s={s} c={c} />
          {s.state === "submitted" ? <Button icon="bot" disabled={c.stage !== "active"} onClick={() => act(() => api("POST", `/submissions/${s.id}/propose`, {}))}>Propose compensation</Button> : null}
          {reviewable ? <ReviewAssistant
            key={`${reviewer}:${c.hash}:${s.id}:${s.state}:${s.judgment_id ?? ""}`}
            c={c}
            s={s}
            enabled={reviewEnabled}
            disabled={session.loading || (session.required && !session.account)}
            existingFeedback={reasons[s.id] ?? ""}
            onApply={(feedback) => setReasons((current) => ({ ...current, [s.id]: feedback }))}
          /> : null}
          {reviewable ? <form className="job-change-form" onSubmit={(e) => { e.preventDefault(); void act(() => api("POST", `/submissions/${s.id}/changes`, { reason: reasons[s.id] ?? "" })); }}>
            <label className="field"><span className="field-label">Changes needed</span><textarea value={reasons[s.id] ?? ""} onChange={(e) => setReasons({ ...reasons, [s.id]: e.target.value })} rows={2} minLength={3} maxLength={2000} required /></label>
            <Button type="submit" variant="secondary" disabled={(reasons[s.id]?.trim().length ?? 0) < 3}>Request changes</Button>
          </form> : null}
          {payouts.map((p) => <div className="stack" key={p.request_id}>
            <PaymentOutcome p={p} />
            {["failed", "disputed", "blocked", "refused"].includes(p.state) ? <StateNote p={p} act={act} /> : null}
            {p.state === "refused" && c.open_judgment?.outcome === "pending" ? <Button variant="secondary" onClick={() => act(() => api("POST", `/contracts/${c.id}/retry`, {}))}>Retry after fixing refusal</Button> : null}
            {p.state === "held" ? s.state === "changes_pending" ? <CancelHeld p={p} config={config} act={act} /> : <ApprovalCard p={p} config={config} act={act} /> : null}
          </div>)}
        </div>
      </Card>;
    })}
  </div>;
}

interface SubmissionPayload {
  client_request_id: string;
  report: string;
  evidence: { deliverable_id: string; url: string; label: string }[];
  invoice: { number: string; amount_usd: string };
}

function readPending(key: string): SubmissionPayload | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw) as SubmissionPayload;
    return typeof p.client_request_id === "string" && typeof p.report === "string" && Array.isArray(p.evidence) && typeof p.invoice?.number === "string" ? p : null;
  } catch { return null; }
}

function forgetPending(keys: string[], requestId: string) {
  for (const key of keys) {
    if (readPending(key)?.client_request_id === requestId) localStorage.removeItem(key);
  }
}

export function BuilderJobWorkflow({ c, token, config, reload }: { c: ContractView; token: string | null; config: AppConfig; reload: () => Promise<void> }) {
  const key = `paperwork.submission.${c.id}`;
  const legacyKey = `covenant.submission.${c.id}`;
  const latest = [...c.submissions].sort((a, b) => b.revision - a.revision)[0];
  const [pending, setPending] = useState<SubmissionPayload | null>(() => readPending(key) ?? readPending(legacyKey));
  const [report, setReport] = useState(pending?.report ?? "");
  const [number, setNumber] = useState(pending?.invoice.number ?? `INV-${String((latest?.revision ?? 0) + 1).padStart(3, "0")}`);
  const [amount, setAmount] = useState(pending?.invoice.amount_usd ?? c.total_usd);
  const [evidence, setEvidence] = useState<Record<string, { url: string; label: string }>>(() => Object.fromEntries(pending?.evidence.map((e) => [e.deliverable_id, { url: e.url, label: e.label }]) ?? []));
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = !latest || latest.state === "changes_requested" || latest.state === "closed";

  const submit = async () => {
    setError(null);
    setRejected(false);
    setBusy(true);
    try {
      let payload = pending;
      if (!payload) {
        const refs = c.terms.scope.flatMap((d) => evidence[d.id]?.url.trim() ? [{ deliverable_id: d.id, url: evidence[d.id]!.url.trim(), label: evidence[d.id]!.label.trim() || d.title }] : []);
        if (report.trim().length < 10) throw new Error("Describe the work in at least 10 characters.");
        if (!refs.length) throw new Error("Add a supporting evidence URL for at least one deliverable.");
        if (!/^\d+(?:\.\d{1,6})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > Number(c.total_usd)) throw new Error("Invoice amount must be positive, within the scope budget, with at most six decimal places.");
        if (!number.trim()) throw new Error("Enter the invoice number.");
        if (c.submissions.some((s) => s.invoice.number === number.trim())) throw new Error("That invoice number is already filed. Use a new number for this revision.");
        const candidate = { client_request_id: crypto.randomUUID(), report: report.trim(), evidence: refs, invoice: { number: number.trim(), amount_usd: amount } };
        const validated = jobSubmissionSchema.safeParse(candidate);
        if (!validated.success) throw new Error(validated.error.issues.map((i) => i.message).join("; "));
        payload = validated.data;
      }
      // Migrate any legacy draft with its exact identity and contents before sending. Never replace its request id.
      localStorage.setItem(key, JSON.stringify(payload));
      setPending(payload);
      await api("POST", `/contracts/${c.id}/submissions`, { ...payload, ...(token ? { contractor_token: token } : {}) });
      forgetPending([key, legacyKey], payload.client_request_id);
      setPending(null);
      setReport("");
      setNumber(`INV-${String((latest?.revision ?? 0) + 2).padStart(3, "0")}`);
      setEvidence({});
      await reload();
    } catch (e) {
      setError((e as Error).message);
      setRejected(e instanceof ApiError && e.status !== undefined && [400, 401, 403, 409, 422].includes(e.status));
    }
    finally { setBusy(false); }
  };

  return <div className="stack job-builder">
    <Card>
      <CardHeader title="Your job" sub="Submit the agreed work, then follow agency review and payment here." actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh status</Button>} />
      <ProposalMethod config={config} />
      {!c.signatures.representative ? <Alert tone="info">The agency must sign these terms before you submit work.</Alert> : null}
      {canSubmit || pending ? <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <SignInGate account={c.terms.contractor.near_account} role="builder" />
        {pending ? <Alert tone="warning">A submission is saved in this browser awaiting confirmation. Retry sends the same identity and contents; the form stays locked until it is confirmed.</Alert> : null}
        {pending && rejected ? <Button variant="secondary" onClick={() => {
          forgetPending([key, legacyKey], pending.client_request_id);
          setPending(null);
          setRejected(false);
        }}>Edit submission after server rejection</Button> : null}
        <label className="field"><span className="field-label">Work report</span><textarea value={report} disabled={!!pending || busy} onChange={(e) => setReport(e.target.value)} minLength={10} maxLength={12000} rows={5} required /><span className="field-hint">Explain what you delivered and how it meets the acceptance criteria.</span></label>
        <div className="grid2">
          <label className="field"><span className="field-label">Invoice number</span><input value={number} disabled={!!pending || busy} onChange={(e) => setNumber(e.target.value)} maxLength={100} required /></label>
          <label className="field"><span className="field-label">Invoice amount · USDC</span><input value={amount} disabled={!!pending || busy} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required /><span className="field-hint">At most {usd(c.total_usd)}. The agent's proposal may be lower.</span></label>
        </div>
        <fieldset className="job-evidence-fields" disabled={!!pending || busy}><legend>Supporting evidence</legend><p className="field-hint">Link each completed deliverable to evidence the agency can inspect.</p>{c.terms.scope.map((d) => <div className="job-evidence-row" key={d.id}>
          <h3>{d.id} · {d.title}</h3><p className="small muted">{d.criteria}</p>
          <div className="grid2">
            <label className="field"><span className="field-label">{d.id} evidence URL</span><input type="url" value={evidence[d.id]?.url ?? ""} onChange={(e) => setEvidence({ ...evidence, [d.id]: { label: evidence[d.id]?.label ?? "", url: e.target.value } })} placeholder="https://" /></label>
            <label className="field"><span className="field-label">{d.id} evidence description</span><input value={evidence[d.id]?.label ?? ""} maxLength={200} onChange={(e) => setEvidence({ ...evidence, [d.id]: { url: evidence[d.id]?.url ?? "", label: e.target.value } })} /></label>
          </div>
        </div>)}</fieldset>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="submit" icon="send" disabled={busy || !c.signatures.representative || (!config.auth.required && !token)}>{busy ? "Submitting…" : pending ? "Retry saved submission" : latest ? "Submit revised report and invoice" : "Submit report and invoice"}</Button>
      </form> : <p className="job-empty">{latest?.state === "disputed" ? "The agency closed this job as disputed, awaiting payment evidence. The amount stays committed and no replacement submission is allowed." : latest?.state === "changes_pending" ? "The agency requested changes. Wait for cancellation of the current payment before submitting a revision." : latest?.state === "settled" ? "Payment is complete. The submission and payment evidence remain below." : "Your submission is under review. The agency can approve compensation or request changes."}</p>}
    </Card>
    {c.submissions.map((s) => <Card key={s.id}>
      <CardHeader title={`Your submission · revision ${s.revision}`} sub={timeText(s.created_at)} actions={<Badge tone={STATES[s.state].tone}>{STATES[s.state].label}</Badge>} />
      <div className="stack"><SubmissionDetails s={s} c={c} />{c.payouts.filter((p) => s.payout_request_ids.includes(p.request_id)).map((p) => <PaymentOutcome key={p.request_id} p={p} />)}</div>
    </Card>)}
  </div>;
}
