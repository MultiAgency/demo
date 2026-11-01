import { useEffect, useState } from "react";
import { api, signMessage } from "../api";
import { Icon } from "../components/icons";
import { Alert, Avatar, Button, dateText, Disclosure, Mono, PageLoading, short, timeText, usd } from "../components/ui";
import type { AppConfig, ContractView } from "../types";

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
      const req = await api("GET", `/contracts/${id}/signing-request?role=contractor`);
      const s = await signMessage(config.provider, req);
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
            <span>Per merged PR</span>
            <strong>{usd(t.rate_per_accepted_pr_usd)}</strong>
          </div>
          <div className="doc-tile">
            <span>Monthly limit</span>
            <strong>{usd(t.monthly_cap_usd)}</strong>
          </div>
          <div className="doc-tile">
            <span>Term</span>
            <strong>
              {dateText(t.start)} – {dateText(t.end)}
            </strong>
          </div>
        </div>

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
            <strong>PRs by @{t.contractor.github}</strong>
            <em>merged by someone else in {t.repos.join(", ")}</em>
          </li>
          <li>
            <Icon name="shieldCheck" size={15} />
            <span>Enforced</span>
            <strong>By NEAR Intents</strong>
            <em>a wallet just for this contract</em>
          </li>
        </ul>

        <Disclosure label="Scope and details">
          <p className="muted">{t.scope}</p>
          <div className="kv-line">
            <span>Terms hash</span>
            <Mono copy={c.hash}>{short(c.hash, 12, 6)}</Mono>
          </div>
          <div className="kv-line">
            <span>Your account</span>
            <Mono>{t.contractor.near_account}</Mono>
          </div>
        </Disclosure>

        {error ? <Alert tone="danger">{error}</Alert> : null}

        {signed ? (
          <div className="doc-done">
            <span className="done-mark">
              <Icon name="check" size={18} strokeWidth={2.6} />
            </span>
            <div>
              <strong>Signed {timeText(signed.signed_at)}</strong>
              <span>You can check the contract wallet at any time.</span>
            </div>
            <a className="btn btn-primary btn-md" href={`#/c/${id}/verify`}>
              <Icon name="shieldCheck" /> <span>Verify wallet</span>
            </a>
          </div>
        ) : !token ? (
          <Alert tone="warning">This link is missing its signing token. Ask {t.company} for the full link.</Alert>
        ) : (
          <Button icon="pen" full onClick={sign}>
            {config.provider === "sim" ? `Sign as ${t.contractor.near_account} (demo wallet)` : "Sign with NEAR wallet"}
          </Button>
        )}
        <p className="doc-foot">Signing is free and off-chain. It doesn't move any money.</p>
      </div>
    </div>
  );
}
