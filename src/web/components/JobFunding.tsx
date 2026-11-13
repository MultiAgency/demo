import { scopeTotal } from "../../shared/terms";
import { useCallback, useState } from "react";
import { fromAtomic } from "../../shared/money";
import { api } from "../api";
import { fundingKey, fundingRequest, type FundingRequest } from "../funding";
import { useSession } from "../session";
import type { AppConfig, ContractView, Deposit } from "../types";
import { useAccountResource } from "../useAccountResource";
import { Alert, Button, Mono, Spinner, timeText, usd } from "./ui";
import type { Act } from "./Payouts";

export function JobFunding({ c, config, act }: { c: ContractView; config: AppConfig; act: Act }) {
  const session = useSession();
  const read = useCallback(() => api<Deposit>("POST", `/contracts/${c.id}/deposit`), [c.id]);
  const resource = useAccountResource(`funding:${c.id}`, read);
  const [notice, setNotice] = useState<{ scope: string | null; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const d = resource.value;
  let q: FundingRequest | null = null;
  let problem: string | null = null;
  let prior = false;
  try {
    if (d && !config.demo_controls) {
      q = fundingRequest(c, d);
      prior = !!localStorage.getItem(fundingKey(q));
    }
  } catch (error) { problem = (error as Error).message; }
  const own = !session.loading && session.account === c.terms.representative.near_account;
  async function fund() {
    if (!q || busy || !own || prior) return;
    setBusy(true); setNotice(null);
    try {
      await session.fundJob(q);
      setNotice({ scope: resource.scope, text: "Wallet request returned. Check the transaction and refresh status until the agent balance is credited. Do not send again." });
    } catch (error) {
      setNotice({ scope: resource.scope, text: `${(error as Error).message} No automatic retry was sent. An interrupted wallet response may still have submitted.` });
    } finally { setBusy(false); }
  }
  return <div className="check-action col job-funding">
    {resource.error ? <Alert tone="warning">Funding instructions could not refresh. {resource.error}</Alert> : null}
    {d ? <div className="deposit">
      <div className="kv-line"><span>Send</span><strong>{usd(scopeTotal(c.terms))} USDC on NEAR, exactly the scope</strong></div>
      <div className="kv-line"><span>From</span><Mono>{c.terms.representative.near_account}</Mono></div>
      <div className="kv-line"><span>To</span><Mono copy={d.address}>{d.address}</Mono></div>
      {d.memo !== null ? <div className="kv-line"><span>Memo</span><Mono copy={d.memo}>{d.memo}</Mono></div> : null}
      {d.minAmount !== null ? <div className="kv-line"><span>Minimum</span><span>{/^\d+$/.test(d.minAmount) ? `${fromAtomic(BigInt(d.minAmount), 6)} USDC` : "Unavailable"}</span></div> : null}
      {d.expiresAt ? <div className="kv-line"><span>Address expires</span><span>{timeText(d.expiresAt)}</span></div> : null}
    </div> : !resource.error ? <span className="muted small"><Spinner /> Getting deposit instructions…</span> : null}
    {!config.demo_controls ? <>
      {q ? <p className="small">USDC contract: <code>{q.token}</code>. One transaction registers this deposit address, then transfers {q.amount} atomic units. Registration deposit: 0.00125 NEAR, plus 1 yoctoNEAR for the transfer. Gas allowance: 60 Tgas total. Review the wallet’s final NEAR fee. Funding moves USDC to this agent; it does not approve a payout.</p> : null}
      {problem ? <Alert tone="warning">{problem}</Alert> : null}
      {prior ? <Alert tone="warning">A funding request may already have been sent from this browser. Check its wallet transaction and refresh job status; do not send again.</Alert> : null}
      <Button icon="wallet" onClick={fund} disabled={!q || !own || busy || prior || !!resource.error || resource.loading}>Review funding in wallet</Button>
      {!own ? <p className="small">Sign in and connect the mainnet wallet for {c.terms.representative.near_account} to fund this job.</p> : null}
    </> : c.platform.agent_id ? <Button icon="coins" onClick={() => act(() => api("POST", "/sim/fund", { contract_id: c.id, agent_id: c.platform.agent_id, usd: c.total_usd }))}>Fund {usd(c.total_usd)} (demo)</Button> : null}
    <Button variant="secondary" disabled={busy} onClick={() => resource.reload()}>Refresh deposit instructions</Button>
    {notice?.scope === resource.scope ? <Alert tone="info">{notice.text}</Alert> : null}
  </div>;
}
