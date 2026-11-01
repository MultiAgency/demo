import { useEffect, useState } from "react";
import { api, signMessage } from "../api";
import { Banner, Button, Card, ErrorText, GuidePanel, KV, usdText, when } from "../components/ui";
import type { AppConfig, ContractView } from "../types";

/** The contractor's own view: plain-language terms and a sign button. No company controls here. */
export function ContractorSign({ id, token, config }: { id: string; token: string | null; config: AppConfig }) {
  const [c, setC] = useState<ContractView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ContractView>("GET", `/contracts/${id}`).then(setC, (e: Error) => setError(e.message));
  }, [id]);

  if (!c) return <div className="container">{error ? <Banner tone="bad">{error}</Banner> : <p className="muted">Loading…</p>}</div>;
  const t = c.terms;
  const signed = c.signatures.contractor;

  async function sign() {
    setError(null);
    try {
      const req = await api("GET", `/contracts/${id}/signing-request?role=contractor`);
      const s = await signMessage(config.provider, req);
      setC(await api<ContractView>("POST", `/contracts/${id}/signatures`, { role: "contractor", signed: s, contractor_token: token }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="container wizard-layout">
      <div className="wizard-main">
        <p className="eyebrow">Work order from {t.company}</p>
        <h1>Hi {t.contractor.name.split(" ")[0]}, please review and sign</h1>
        <Card title="In plain language">
          <p>
            {t.company} will pay <strong>{usdText(t.rate_per_accepted_pr_usd)}</strong> for each of your pull requests that someone else merges in{" "}
            <strong>{t.repos.join(", ")}</strong>, up to <strong>{usdText(t.monthly_cap_usd)} per month</strong>, from {t.start} to {t.end}.
          </p>
          <p>
            Payments go in USDC to <code>{t.payee.address}</code> on NEAR, from a wallet that exists only for this contract. Its limits are set from these
            terms and enforced by NEAR Intents.
          </p>
          <KV rows={[["Scope", t.scope], ["Your NEAR account", <code>{t.contractor.near_account}</code>], ["Your GitHub", `@${t.contractor.github}`], ["Terms hash", <code>{c.hash}</code>]]} />
        </Card>
        <ErrorText error={error} />
        {signed ? (
          <Card title="Signed">
            <p>You signed on {when(signed.signed_at)}.</p>
            <a className="btn btn-primary" href={`#/c/${id}/verify`}>
              Verify your contract wallet →
            </a>
          </Card>
        ) : !token ? (
          <Banner tone="warn">This link is missing its signing token. Ask {t.company} to send the full link.</Banner>
        ) : (
          <div className="form-actions">
            <Button onClick={sign}>{config.provider === "sim" ? `Sign as ${t.contractor.near_account} (demo wallet)` : "Sign with my NEAR wallet"}</Button>
          </div>
        )}
        <p className="hint">
          <a href={`#/c/${id}`}>Back to the company view</a>
        </p>
      </div>
      <GuidePanel step="contractor-sign" />
    </div>
  );
}
