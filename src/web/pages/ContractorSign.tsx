import { useEffect, useState } from "react";
import { api, signMessage } from "../api";
import { SignInGate } from "../components/Account";
import { Icon } from "../components/icons";
import { Alert, Avatar, Button, dateText, Disclosure, Mono, PageLoading, short, timeText, usd } from "../components/ui";
import type { AppConfig, ContractView, TermsSigningRequest } from "../types";

/** The contractor's page: what they're agreeing to, and one button. */
export function ContractorSign({ id, token, config }: { id: string; token: string | null; config: AppConfig }) {
  const [c, setC] = useState<ContractView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ContractView>("GET", `/contracts/${id}`).then(setC, (e: Error) => setError(e.message));
  }, [id]);

  if (!c) return error ? <div className="narrow"><Alert tone="danger">{error}</Alert></div> : <PageLoading />;
  const t = c.terms;
  const signed = c.signatures.contractor;

  async function sign() {
    setError(null);
    try {
      const req = await api<TermsSigningRequest>("GET", `/contracts/${id}/signing-request?role=contractor`);
      const s = await signMessage(config, req);
      setC(await api<ContractView>("POST", `/contracts/${id}/signatures`, { role: "contractor", signed: s, contractor_token: token }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="narrow">
      <div className="doc">
        <div className="doc-head">
          <Avatar name={t.company} tone="accent" />
          <div>
            <div className="doc-kicker">Work order from {t.company}</div>
            <h1>{signed ? "You signed this contract" : `${t.contractor.name.split(" ")[0]}, review and sign`}</h1>
          </div>
        </div>

        <div className="doc-tiles">
          <div className="doc-tile">
            <span>Scope</span>
            <strong>{usd(t.scope.reduce((n, d) => n + Number(d.value_usd), 0))}</strong>
          </div>
          <div className="doc-tile">
            <span>Deliverables</span>
            <strong>{t.scope.length}</strong>
          </div>
          <div className="doc-tile">
            <span>Term</span>
            <strong>
              {dateText(t.start)} – {dateText(t.end)}
            </strong>
          </div>
        </div>

        <ol className="doc-scope">
          {t.scope.map((d) => (
            <li key={d.id}>
              <span className="scope-id">{d.id}</span>
              <div>
                <strong>{d.title}</strong>
                <span>{d.criteria}</span>
              </div>
              <span className="num">{usd(d.value_usd)}</span>
            </li>
          ))}
        </ol>

        <ul className="doc-list">
          <li>
            <Icon name="user" size={15} />
            <span>Paid to</span>
            <strong>{t.payee.address}</strong>
            <em>USDC on NEAR</em>
          </li>
          <li>
            <Icon name="pr" size={15} />
            <span>For</span>
            <strong>Merged PRs by @{t.contractor.github}</strong>
            <em>judged against the scope, in {t.repos.join(", ")}</em>
          </li>
          <li>
            <Icon name="shieldCheck" size={15} />
            <span>Enforced</span>
            <strong>{config.platform === "fake" ? "By the platform stand-in (simulated)" : "By the MultiAgency platform"}</strong>
            <em>an agent just for this contract; every payout approved by {t.company}</em>
          </li>
        </ul>

        <Disclosure label="Scope and details">
          <div className="kv-line">
            <span>Terms hash</span>
            <Mono copy={c.hash}>{short(c.hash, 12, 6)}</Mono>
          </div>
          <div className="kv-line">
            <span>Your account</span>
            <Mono>{t.contractor.near_account}</Mono>
          </div>
        </Disclosure>

        {c.payee_registered === false ? (
          <Alert tone="warning">{t.payee.address} isn't registered on the USDC contract yet. Register it, or payouts will wait.</Alert>
        ) : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {!signed ? <SignInGate account={t.contractor.near_account} role="contractor" /> : null}

        {signed ? (
          <div className="doc-done">
            <span className="done-mark">
              <Icon name="check" size={18} strokeWidth={2.6} />
            </span>
            <div>
              <strong>Signed {timeText(signed.signed_at)}</strong>
              <span>You can check the contract's policy at any time.</span>
            </div>
            <a className="btn btn-primary btn-md" href={`#/c/${id}/verify`}>
              <Icon name="shieldCheck" /> <span>Verify policy</span>
            </a>
          </div>
        ) : !token ? (
          <Alert tone="warning">This link is missing its signing token. Ask {t.company} for the full link.</Alert>
        ) : (
          <Button icon="pen" full onClick={sign} disabled={!config.demo_controls}>
            {config.demo_controls ? `Sign as ${t.contractor.near_account} (demo wallet)` : "Sign with NEAR wallet"}
          </Button>
        )}
        <p className="doc-foot">Signing is free and off-chain. It doesn't move any money.</p>
      </div>
    </div>
  );
}
