import { useCallback, useState } from "react";
import { nearAmount, type RegistrationQuote } from "../../shared/registration";
import { api } from "../api";
import { useAccountResource } from "../useAccountResource";
import { useSession } from "../session";
import { Alert, Button } from "./ui";

export function PayeeRegistration({ id, account, builder }: { id: string; account: string; builder: string }) {
  const session = useSession();
  const read = useCallback(() => api<RegistrationQuote>("GET", `/contracts/${id}/registration`), [id]);
  const resource = useAccountResource(`registration:${id}`, read);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ scope: string | null; text: string } | null>(null);
  const q = resource.value;
  const separatePayee = account !== builder;
  const own = !separatePayee && !session.loading && session.account === account;
  async function register() {
    if (!q || busy || !own) return;
    setBusy(true);
    setNotice(null);
    try {
      const fresh = await read();
      if (fresh.registered) { await resource.reload(); return; }
      if (fresh.deposit_yocto !== q.deposit_yocto || fresh.gas_estimate_yocto !== q.gas_estimate_yocto || Date.parse(q.expires_at) <= Date.now())
        throw new Error("The cost changed or the quote expired. Check again and review the new quote.");
      await session.registerUsdc(q);
      setNotice({ scope: resource.scope, text: "Wallet request returned. Check registration to confirm the on-chain result before retrying." });
    } catch (e) {
      setNotice({ scope: resource.scope, text: `${(e as Error).message} No automatic retry was sent. Check registration before trying again; an interrupted response may still have submitted.` });
    } finally { setBusy(false); await resource.reload(); }
  }
  return <section className="stack" aria-label="Receive USDC" style={{ overflowWrap: "anywhere" }}>
    <h2>Receive USDC</h2>
    <Alert tone={q?.registered ? "info" : "warning"}>
      {resource.error ? `Registration status for ${account} is unavailable. Check again before opening a wallet transaction.`
        : !q ? `Checking whether ${account} can receive USDC…`
        : q.registered ? `${account} is registered to receive USDC.`
        : `To receive USDC, ${account} needs a one-time token registration. This is separate from accepting the job and does not fund it.`}
    </Alert>
    {resource.error ? <Alert tone="warning">Registration could not be checked. {resource.error}</Alert> : null}
    {q && !q.registered && !resource.error ? <>
      <p className="small">Storage deposit: {nearAmount(q.deposit_yocto)} NEAR. Gas allowance: 30 Tgas; estimated gas cost at the quoted price: {nearAmount(q.gas_estimate_yocto)} NEAR. Actual fees can vary; review the wallet’s final amount. Quote valid until {new Date(q.expires_at).toLocaleTimeString()}.</p>
      <p className="small">Contract: {q.token}. Action: storage_deposit for {q.account}, registration_only: true.</p>
      {!separatePayee ? <Button onClick={register} disabled={busy || !own || Date.parse(q.expires_at) <= Date.now()}>Review registration in wallet</Button> : null}
      {separatePayee ? <p className="small">This job pays a separate account. Ask {account} to register USDC using its own wallet, then check registration here. The payee does not need access to this private job.</p>
        : !own ? <p className="small">Sign in and connect the wallet for {account} to register.</p> : null}
    </> : null}
    <Button variant="secondary" onClick={() => resource.reload()} disabled={busy}>Check registration and refresh quote</Button>
    {notice?.scope === resource.scope ? <Alert tone="info">{notice.text}</Alert> : null}
  </section>;
}
