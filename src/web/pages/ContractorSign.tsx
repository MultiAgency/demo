import { PayeeRegistration } from "../components/PayeeRegistration";
import { useCallback, useState } from "react";
import { api, signMessage } from "../api";
import { SignInGate } from "../components/Account";
import { BuilderJobWorkflow } from "../components/JobWorkflow";
import { Icon } from "../components/icons";
import { Alert, Avatar, Button, dateText, Disclosure, Mono, PageLoading, short, timeText, usd } from "../components/ui";
import type { AppConfig, ContractView, TermsSigningRequest } from "../types";
import { AccountReadGate, useAccountResource } from "../useAccountResource";
import { useSession } from "../session";

/** The contractor's page: what they're agreeing to, and one button. */
export function ContractorSign({ id, token, config }: { id: string; token: string | null; config: AppConfig }) {
  const session = useSession();
  const read = useCallback(() => api<ContractView>("GET", `/contracts/${id}`), [id]);
  const resource = useAccountResource(`builder:${id}`, read, { refreshMs: 5000 });
  const c = resource.value;
  const reload = resource.reload;
  const [actionError, setActionError] = useState<{ scope: string | null; message: string } | null>(null);
  const error = resource.error
    ? c ? `Status could not refresh. Showing the last confirmed status; your draft is kept. ${resource.error}` : resource.error
    : (actionError?.scope === resource.scope ? actionError.message : null);

  if (!resource.enabled) return <AccountReadGate className="narrow" />;
  if (!c) return error ? <div className="narrow stack"><Alert tone="danger">{error}</Alert><Button variant="secondary" onClick={reload}>Retry loading job</Button></div> : <PageLoading />;
  const t = c.terms;
  const signed = c.signatures.contractor;

  async function sign() {
    setActionError(null);
    try {
      const req = await api<TermsSigningRequest>("GET", `/contracts/${id}/signing-request?role=contractor`);
      const s = await signMessage(config, req, session.signWorkflow);
      await api<ContractView>("POST", `/contracts/${id}/signatures`, { role: "contractor", signed: s, contractor_token: token });
    } catch (e) {
      setActionError({ scope: resource.scope, message: (e as Error).message });
    }
    await reload();
  }

  return (
    <div className="narrow">
      <div className="doc">
        <div className="doc-head">
          <Avatar name={t.company} tone="accent" />
          <div>
            <div className="doc-kicker">Job from {t.company}</div>
            <h1>{signed ? "You accepted this job" : `${t.contractor.name.split(" ")[0]}, review and sign`}</h1>
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
            <strong>{t.v === 3 ? "A report, invoice and supporting evidence" : `Merged PRs by @${t.contractor.github}`}</strong>
            <em>{t.v === 3 ? "assessed against the agreed acceptance criteria" : `judged against the scope, in ${t.repos.join(", ")}`}</em>
          </li>
          <li>
            <Icon name="shieldCheck" size={15} />
            <span>Enforced</span>
            <strong>{config.platform === "fake" ? "By the platform stand-in (simulated)" : "By the MultiAgency platform"}</strong>
            <em>an agent just for this job; every payout approved by {t.company}</em>
          </li>
        </ul>

        {t.v === 3 && t.agency_owner ? <p className="small">DAO owner: {t.agency_owner.account_id}. The representative signs these terms; the DAO separately votes on agent setup and payouts.</p> : null}
        {t.v === 3 ? <p className="small">Payment terms: completed scope value less amounts already committed, capped by your invoice. {t.company} explicitly approves each payout. USDC payment to {t.payee.address} follows approval; confirmation appears below after settlement.</p> : null}

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

        {signed && c.stage !== "active" && c.stage !== "ended" && c.stage !== "frozen" ? <Alert tone="info">Terms accepted. Waiting on {t.company} to finish preparing this job. Registration below is separate; it does not complete agency setup.</Alert> : null}
        {config.demo_controls
          ? c.payee_registered === false ? <Alert tone="warning">USDC registration is simulated in this demo. No live registration transaction is available here.</Alert> : null
          : <PayeeRegistration key={id} id={id} account={t.payee.address} builder={t.contractor.near_account} />}
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {!signed ? <SignInGate account={t.contractor.near_account} role="contractor" /> : null}

        {signed ? (
          <div className="doc-done">
            <span className="done-mark">
              <Icon name="check" size={18} strokeWidth={2.6} />
            </span>
            <div>
              <strong>Signed {timeText(signed.signed_at)}</strong>
              <span>You can check the job's policy at any time.</span>
            </div>
            <a className="btn btn-primary btn-md" href={`#/c/${id}/verify`}>
              <Icon name="shieldCheck" /> <span>Verify policy</span>
            </a>
          </div>
        ) : !token ? (
          <Alert tone="warning">This link is missing its signing token. Ask {t.company} for the full link.</Alert>
        ) : (
          <Button icon="pen" full onClick={sign} disabled={!config.demo_controls && (session.loading || session.account !== t.contractor.near_account)}>
            {config.demo_controls ? `Sign as ${t.contractor.near_account} (demo wallet)` : "Sign with NEAR wallet"}
          </Button>
        )}
        <p className="doc-foot">Signing is free and off-chain. It doesn't move any money.</p>
      </div>
      {signed && t.v === 3 ? <BuilderJobWorkflow key={id} c={c} token={token} config={config} reload={reload} /> : null}
    </div>
  );
}
