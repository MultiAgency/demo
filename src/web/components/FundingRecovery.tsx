import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FundingRecoveryObservation, FundingRecoveryView } from "../../shared/funding-recovery";
import { fromAtomic } from "../../shared/money";
import { api } from "../api";
import { fundingKey, fundingRecoveryRequest, type FundingRequest } from "../funding";
import { useSession } from "../session";
import { useAccountResource } from "../useAccountResource";
import type { ContractView } from "../types";
import { Alert, Button, Mono, Spinner, timeText } from "./ui";
import { Icon } from "./icons";

export function FundingRecovery({ c }: { c: ContractView }) {
  const [open, setOpen] = useState(false);
  return <details className="disclosure" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Icon name="chevronRight" size={14} /> Recover funding</summary>
    <div className="disclosure-body">
      <p className="small">Use this review for existing credit or an interrupted funding attempt. It never requests another deposit address or clears the original records.</p>
      {open ? <RecoveryReview key={c.id} c={c} /> : null}
    </div>
  </details>;
}

function RecoveryReview({ c }: { c: ContractView }) {
  const session = useSession();
  const read = useCallback(() => api<FundingRecoveryView>("GET", `/contracts/${c.id}/funding-recovery`), [c.id]);
  const resource = useAccountResource(`funding-recovery:${c.id}`, read);
  const id = useId();
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ scope: string | null; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const view = resource.value;
  let q: FundingRequest | null = null, problem: string | null = null, prior = false;
  try {
    if (view?.state === "ready") {
      q = fundingRecoveryRequest(c, view, now);
      prior = !!localStorage.getItem(fundingKey(q));
    }
  } catch (error) { problem = (error as Error).message; }
  const own = !session.loading && session.account === c.terms.representative.near_account;
  const reviewedKey = q?.recovery ? `${resource.scope}:${q.recovery.plan_hash}` : null;
  async function fund() {
    if (!q || !own || pending.current || prior || !reviewedKey || acknowledged !== reviewedKey || resource.loading || resource.error) return;
    pending.current = true; setBusy(true); setNotice(null);
    try {
      await session.fundJob(q);
      setNotice({ scope: resource.scope, text: "Wallet request returned. Follow the original transaction and agent credit. This is not confirmation of funding or builder payment; do not send again." });
    } catch (error) {
      setNotice({ scope: resource.scope, text: `${(error as Error).message} No automatic retry was sent. If a recovery request was recorded, its outcome must be reconciled before another wallet attempt.` });
    } finally { pending.current = false; setBusy(false); }
  }
  return <div className="stack funding-recovery-review">
    {c.platform.balance_usd !== null ? <p className="small">Last observed agent balance: <strong>{c.platform.balance_usd} USDC</strong>. The recovery must verify current available credit.</p> : null}
    {resource.loading ? <p role="status"><Spinner /> Reading existing reconciliation…</p> : null}
    {resource.error ? <Alert tone="warning">The review could not refresh. {resource.error} Wallet review is blocked until a fresh result is available.</Alert> : null}
    {view?.state === "blocked" ? <Alert tone="warning">{view.message}</Alert> : null}
    {view?.state === "blocked" && view.code === "wallet_outcome_unknown" ? <>
      <p className="small">Paperwork resolves this attempt only on evidence: the agent holding the signed total, or the platform confirming the attempt's expired destination received nothing. A cancelled wallet or an error is not evidence.</p>
      <Button variant="secondary" disabled={!own || busy} onClick={async () => {
        setBusy(true); setNotice(null);
        try {
          const seen = await api<FundingRecoveryObservation>("POST", `/contracts/${c.id}/funding-recovery/observe`);
          setNotice({ scope: resource.scope, text: seen.message });
          if (seen.outcome) await resource.reload();
        } catch (error) { setNotice({ scope: resource.scope, text: (error as Error).message }); }
        finally { setBusy(false); }
      }}>Check recovery outcome</Button>
    </> : null}
    {q && view?.state === "ready" ? <>
      <dl className="deposit">
        <div className="kv-line"><dt>Signed scope target</dt><dd>{fromAtomic(BigInt(view.plan.target_atomic), 6)} USDC</dd></div>
        <div className="kv-line"><dt>Verified existing credit</dt><dd>{fromAtomic(BigInt(view.plan.credited_atomic), 6)} USDC</dd></div>
        <div className="kv-line"><dt>Remaining credit needed</dt><dd>{fromAtomic(BigInt(view.plan.expected_credit_atomic), 6)} USDC</dd></div>
        <div className="kv-line"><dt>Provider fee included</dt><dd>{fromAtomic(BigInt(view.plan.fee_atomic), 6)} USDC</dd></div>
        <div className="kv-line"><dt>Exact wallet transfer</dt><dd><strong>{fromAtomic(BigInt(q.amount), 6)} USDC</strong> · {q.amount} atomic units</dd></div>
        <div className="kv-line"><dt>From</dt><dd><Mono>{q.sender}</Mono></dd></div>
        <div className="kv-line"><dt>Validated destination</dt><dd><Mono copy={q.address}>{q.address}</Mono></dd></div>
        <div className="kv-line"><dt>Route minimum</dt><dd>{fromAtomic(BigInt(view.plan.destination.minimum_atomic), 6)} USDC</dd></div>
        <div className="kv-line"><dt>Review valid until</dt><dd>{timeText(q.expires ?? "")}</dd></div>
        <div className="kv-line"><dt>Original allocation resolution</dt><dd><Mono>{view.plan.original_allocation.evidence_reference}</Mono></dd></div>
        <div className="kv-line"><dt>Reconciliation</dt><dd><Mono>{view.plan.reconciliation_id}</Mono></dd></div>
      </dl>
      <p className="small">The wallet registers this destination (0.00125 NEAR), then transfers the exact USDC amount with 1 yoctoNEAR attached. Gas allowance: 60 Tgas. Review the wallet’s final NEAR fee. This does not approve a builder payout.</p>
      <label className="funding-recovery-ack" htmlFor={id}>
        <input id={id} type="checkbox" checked={acknowledged === reviewedKey} disabled={!own || busy || !!resource.error || resource.loading || prior} onChange={event => setAcknowledged(event.target.checked ? reviewedKey : null)} />
        <span>I reviewed the existing credit, exact transfer, provider fee and destination.</span>
      </label>
    </> : null}
    {problem ? <Alert tone="warning">{problem}</Alert> : null}
    {prior ? <Alert tone="warning">A wallet request may already have been sent from this browser. Reconcile that original transaction; this review cannot clear its marker.</Alert> : null}
    <Button icon="wallet" onClick={fund} disabled={!q || !own || busy || prior || !reviewedKey || acknowledged !== reviewedKey || !!resource.error || resource.loading}>Review recovered funding in wallet</Button>
    {!own ? <p className="small">Sign in with the named agency account to review recovery.</p> : null}
    <Button variant="secondary" disabled={busy || resource.loading} onClick={() => { setAcknowledged(null); void resource.reload(); }}>Refresh recovery review</Button>
    {notice?.scope === resource.scope ? <Alert tone="info">{notice.text}</Alert> : null}
  </div>;
}
