import { useEffect, useRef, useState } from "react";
import { DEMO_TERMS } from "../../shared/demo";
import { JOB_PAYMENT_TERMS, MARKET_PAYMENT_TERMS, payoutEndInstant } from "../../shared/terms";
import { api, links } from "../api";
import { SignInGate } from "../components/Account";
import { Icon } from "../components/icons";
import { PolicyCard } from "../components/PolicyCard";
import { Alert, Button, PageLoading, usd } from "../components/ui";
import { jobDraftKey, readJobDraft, saveJobDraft, type JobDraft } from "../job-draft";
import { useSession } from "../session";
import type { MarketJobSource } from "../../shared/market-board";
import type { AppConfig, Deliverable } from "../types";

type Form = JobDraft;

/** Demo dates relative to today: the 1st of this month to the last day of next month (UTC). */
function demoDates(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10),
    end: new Date(Date.UTC(y, m + 2, 0)).toISOString().slice(0, 10),
  };
}

const blank: Form = {
  workflow: "report_and_invoice", title: "", description: "", company: "", rep: "", dao: "", contractorName: "", github: "", contractorAccount: "",
  payee: "", start: "", end: "", reviewDays: "14", repos: "", scope: [{ id: "d1", title: "", criteria: "", value_usd: "" }],
};

/** The keyless demo starts from its fixture job; real accounts start blank. */
const demo: Form = {
  workflow: "report_and_invoice",
  title: "",
  description: "",
  company: DEMO_TERMS.company,
  rep: DEMO_TERMS.representative.near_account,
  dao: "",
  contractorName: DEMO_TERMS.contractor.name,
  github: DEMO_TERMS.contractor.github,
  contractorAccount: DEMO_TERMS.contractor.near_account,
  payee: DEMO_TERMS.payee.address,
  ...demoDates(),
  reviewDays: "14",
  repos: DEMO_TERMS.repos.join(", "),
  scope: DEMO_TERMS.scope.map((d) => ({ ...d })),
};

function Field(props: { label: string; hint?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`field${props.wide ? " field-wide" : ""}`}>
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint ? <span className="field-hint">{props.hint}</span> : null}
    </label>
  );
}

export function NewContract({ config }: { config: AppConfig }) {
  const session = useSession();
  if (session.required && session.loading) return <PageLoading />;
  const scope = session.required ? session.account : "demo";
  return <NewContractForm key={scope ?? "signed-out"} config={config} draftKey={scope ? jobDraftKey(scope) : null} />;
}

function NewContractForm({ config, draftKey }: { config: AppConfig; draftKey: string | null }) {
  const [restored] = useState(() => {
    try { return draftKey ? readJobDraft(sessionStorage, draftKey) : null; } catch { return null; }
  });
  const session = useSession();
  const [empty] = useState<Form>(() => {
    const initial = config.demo_controls ? demo : blank;
    return session.account ? { ...initial, rep: session.account } : initial;
  });
  const [f, setF] = useState<Form>(restored ?? empty);
  const [draftStatus, setDraftStatus] = useState("");
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!draftKey || f === empty) return;
    try {
      if (!saveJobDraft(sessionStorage, draftKey, f)) throw new Error("Draft storage unavailable");
      setDraftStatus("Draft saved in this tab.");
    } catch { setDraftStatus("Draft could not be saved in this tab. Keep this page open until you create it."); }
  }, [draftKey, f, empty]);
  // The signed-in NEAR account is the representative by default.
  useEffect(() => {
    if (session.account) setF((x) => x.rep === session.account ? x : { ...x, rep: session.account! });
  }, [session.account]);

  const set = (k: Exclude<keyof Form, "scope">) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const setItem = (i: number, k: keyof Deliverable) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, scope: f.scope.map((d, j) => (j === i ? { ...d, [k]: e.target.value } : d)) });
  const addItem = () => {
    const used = new Set(f.scope.map((d) => d.id));
    const id = Array.from({ length: 10 }, (_, i) => `d${i + 1}`).find((x) => !used.has(x));
    if (id) setF({ ...f, scope: [...f.scope, { id, title: "", criteria: "", value_usd: "" }] });
  };
  // Only a Market-sourced report-and-invoice job may settle on the Market.
  const market = f.workflow === "report_and_invoice" && !!f.marketJobId && !!f.marketSettled;
  const removeItem = (i: number) => setF({ ...f, scope: f.scope.filter((_, j) => j !== i) });
  const [marketInput, setMarketInput] = useState("");
  const [marketJob, setMarketJob] = useState<MarketJobSource | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  /** Pre-fill from a public Market job. Every field stays editable; the job id is signed as the source. */
  async function importMarketJob() {
    setMarketError(null);
    const id = marketInput.trim().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]?.toLowerCase();
    if (!id) { setMarketError("Paste a Market job link or its job id."); return; }
    try {
      const job = await api<MarketJobSource>("GET", `/market/jobs/${id}`);
      setMarketJob(job);
      const value = job.budget_amount && /^USDC?$/i.test(job.budget_token) ? job.budget_amount.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1") : "";
      setF((x) => ({
        ...x, workflow: "report_and_invoice", marketJobId: job.job_id,
        scope: [{ id: "d1", title: job.title.slice(0, 120), criteria: job.description.slice(0, 400) || job.title.slice(0, 400), value_usd: value }],
      }));
    } catch (e) { setMarketError((e as Error).message); }
  }
  const repos = f.repos.split(/[\s,]+/).filter(Boolean);
  const total = f.scope.reduce((n, d) => n + (Number(d.value_usd) || 0), 0);

  const v3 = f.workflow === "report_and_invoice";
  // The signed review window applies to platform-paid report-and-invoice jobs only.
  const reviewDays = v3 && !market ? Number(f.reviewDays) || 0 : 0;
  const payUntil = f.end && reviewDays > 0 && Number.isInteger(reviewDays) && !Number.isNaN(Date.parse(f.end)) ? payoutEndInstant({ end: f.end, payment_terms: { settlement: JOB_PAYMENT_TERMS.settlement, review_days: reviewDays } }).slice(0, 10) : undefined;

  async function submit() {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await api<{ id: string; contractor_token: string }>("POST", "/contracts", {
        v: v3 ? 3 : 2,
        ...(v3 && f.title.trim() && { title: f.title.trim() }),
        ...(v3 && f.description.trim() && { description: f.description.trim() }),
        company: f.company,
        representative: { near_account: f.rep },
        ...(f.workflow === "report_and_invoice" && f.dao.trim() && { agency_owner: { type: "dao", account_id: f.dao.trim() } }),
        ...(f.workflow === "report_and_invoice" && f.marketJobId && { market_source: { job_id: f.marketJobId } }),
        contractor: { name: f.contractorName, ...((!v3 || f.github.trim()) && { github: f.github }), near_account: f.contractorAccount },
        ...(!market && { payee: { chain: "near", address: f.payee }, asset: DEMO_TERMS.asset }),
        scope: f.scope,
        start: f.start,
        end: f.end,
        ...((!v3 || repos.length > 0) && { repos }),
        acceptance: f.workflow,
        ...(f.workflow === "report_and_invoice" ? { payment_terms: market ? MARKET_PAYMENT_TERMS : { ...JOB_PAYMENT_TERMS, per_payment: "scope_total", ...(reviewDays > 0 && { review_days: reviewDays }) } } : {}),
      });
      links.save(res.id, res.contractor_token);
      try { if (draftKey) sessionStorage.removeItem(draftKey); } catch { /* Storage may be unavailable. */ }
      window.location.hash = `/c/${res.id}`;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <a href="#/" className="crumb">
            <Icon name="chevronLeft" size={14} /> Jobs
          </a>
          <h1>New job</h1>
          <p className="page-sub">Agree the scope, budget and deadline. The agency approves every payout.</p>
        </div>
      </header>

      {draftKey ? <div className="header-actions draft-notice">
        <p className="small muted" role="status">{draftStatus || (restored ? "Restored your unfinished draft." : "Unfinished drafts are saved in this tab for this account.")}</p>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => {
          try { sessionStorage.removeItem(draftKey); } catch { /* Reset still works without storage. */ }
          setF(empty);
          setError(null);
          setDraftStatus("Draft discarded.");
        }}>Discard draft</Button>
      </div> : null}

      <div className="split">
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <section className="form-section">
            <h2><Icon name="external" /> From Agent Market (optional)</h2>
            <div className="stack">
              <div className="row gap">
                <input aria-label="Market job link or id" value={marketInput} onChange={(e) => setMarketInput(e.target.value)} placeholder="Market job link or job id" disabled={!!f.marketJobId} />
                {f.marketJobId
                  ? <Button variant="ghost" size="sm" onClick={() => { setF({ ...f, marketJobId: undefined, marketSettled: undefined }); setMarketJob(null); setMarketInput(""); }}>Remove source</Button>
                  : <Button variant="secondary" size="sm" onClick={importMarketJob}>Import</Button>}
              </div>
              {marketError ? <Alert tone="danger">{marketError}</Alert> : null}
              {f.marketJobId ? <>
                <p className="small">Market job <code>{f.marketJobId}</code>{marketJob ? ` · ${marketJob.status.replace("_", " ")} · budget ${marketJob.budget_amount ?? "unset"} ${marketJob.budget_token} · acceptance window ${marketJob.acceptance_window_days} days` : ""}. Review the pre-filled scope; the Market description is not acceptance criteria. Who pays this job?</p>
                <label className="row gap">
                  <input className="job-radio" type="radio" name="settlement" checked={!f.marketSettled} onChange={() => setF({ ...f, marketSettled: false })} />
                  <span><strong>The platform</strong><br /><span className="field-hint">Close the Market job without an award (refunding any award) first. The agent proposes compensation and you approve each payout. Setup and funding stay blocked until the Market job reads closed.</span></span>
                </label>
                <label className="row gap">
                  <input className="job-radio" type="radio" name="settlement" checked={!!f.marketSettled} onChange={() => setF({ ...f, marketSettled: true })} />
                  <span><strong>The Agent Market</strong><br /><span className="field-hint">You already awarded this job. The Market pays its awarded price when you accept there, or when its acceptance window lapses. Paperwork reviews the report and invoice and makes no payment; there is no NEAR payee.</span></span>
                </label>
              </> : <p className="field-hint">Import a public job to pre-fill the scope and record it as this offer's source.</p>}
            </div>
          </section>
          <section className="form-section">
            <h2><Icon name="file" /> Work and payment terms</h2>
            <div className="stack">
              <label className="row gap">
                <input className="job-radio" type="radio" name="workflow" checked={f.workflow === "report_and_invoice"} onChange={() => setF({ ...f, workflow: "report_and_invoice" })} />
                <span><strong>Report and invoice</strong><br /><span className="field-hint">Builder submits evidence. An agent proposes compensation; the agency approves or requests changes.</span></span>
              </label>
              <label className="row gap">
                <input className="job-radio" type="radio" name="workflow" checked={f.workflow === "merged_to_default_branch_by_other"} disabled={!!f.marketJobId} onChange={() => setF({ ...f, workflow: "merged_to_default_branch_by_other" })} />
                <span><strong>Pay on merge</strong><br /><span className="field-hint">Existing workflow: independently merged PRs are judged against the signed scope.</span></span>
              </label>
              {f.workflow === "report_and_invoice" ? <p className="small">Compensation is the agreed value of completed scope, less amounts already committed, capped by the invoice. Payment follows explicit agency approval, in USDC to the agreed NEAR payee.</p> : null}
            </div>
          </section>
          <section className="form-section">
            <h2>
              <Icon name="building" /> Parties
            </h2>
            {v3 ? <div className="stack">
              <Field label="Job title (optional)" hint="Shown to both parties in place of the first deliverable's title">
                <input value={f.title} onChange={set("title")} minLength={3} maxLength={120} />
              </Field>
              <Field label="Description (optional)" hint="Context for the work. The deliverables below remain the acceptance criteria.">
                <textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} minLength={3} maxLength={2000} />
              </Field>
            </div> : null}
            <div className="grid2">
              <Field label="Company">
                <input value={f.company} onChange={set("company")} required />
              </Field>
              {f.workflow === "report_and_invoice" ? <Field label="DAO owner (optional)" hint="Leave blank for wallet ownership. A DAO owner votes on setup and every payout."><input value={f.dao} onChange={set("dao")} placeholder="agency.sputnik-dao.near" /></Field> : null}
              <Field label="Representative" hint="NEAR account that signs the job terms; the owner separately approves payment">
                <input value={f.rep} onChange={set("rep")} required />
              </Field>
              <Field label="Builder">
                <input value={f.contractorName} onChange={set("contractorName")} required />
              </Field>
              <Field label="Builder's NEAR account">
                <input value={f.contractorAccount} onChange={set("contractorAccount")} required />
              </Field>
              <Field label={v3 ? "GitHub username (optional)" : "GitHub username"} hint={v3 ? "Builder identity for supporting code evidence" : "Whose merged PRs count"}>
                <div className="input-affix prefix">
                  <span>@</span>
                  <input value={f.github} onChange={set("github")} required={!v3} />
                </div>
              </Field>
              {market ? null : <Field label="Payee" hint="The only account the agent can pay">
                <div className="input-affix">
                  <input value={f.payee} onChange={set("payee")} required />
                  <span>USDC · NEAR</span>
                </div>
              </Field>}
            </div>
          </section>

          <section className="form-section">
            <div className="section-head">
              <h2>
                <Icon name="file" /> Scope
              </h2>
              <span className="scope-total num">{usd(total)} total</span>
            </div>
            <ol className="scope-edit">
              {f.scope.map((d, i) => (
                <li key={d.id}>
                  <span className="scope-id">{d.id}</span>
                  <div className="scope-fields">
                    <input value={d.title} onChange={setItem(i, "title")} placeholder="Deliverable" aria-label={`${d.id} title`} required />
                    <textarea rows={2} value={d.criteria} onChange={setItem(i, "criteria")} placeholder="Done when…" aria-label={`${d.id} acceptance criteria`} required />
                  </div>
                  <div className="input-affix prefix scope-value">
                    <span>$</span>
                    <input value={d.value_usd} onChange={setItem(i, "value_usd")} inputMode="decimal" aria-label={`${d.id} value`} required />
                  </div>
                  <button type="button" className="icon-btn" onClick={() => removeItem(i)} disabled={f.scope.length === 1} aria-label={`Remove ${d.id}`}>
                    <Icon name="x" />
                  </button>
                </li>
              ))}
            </ol>
            <div className="scope-foot">
              <Button variant="ghost" size="sm" icon="plus" onClick={addItem} disabled={f.scope.length >= 10}>
                Add deliverable
              </Button>
              <span className="field-hint">{f.workflow === "report_and_invoice" ? "Each deliverable has acceptance criteria and an agreed maximum value." : 'PRs link to a deliverable with a "Scope: d2" line. The agent judges how complete each one is.'}</span>
            </div>
          </section>

          <section className="form-section">
            <h2>
              <Icon name="calendar" /> Term and code
            </h2>
            <div className="grid2">
              <Field label="Start">
                <input type="date" value={f.start} onChange={set("start")} required />
              </Field>
              <Field label="End" hint={v3 && !market ? "Work is due by this date" : "Paperwork's payout permission ends then"}>
                <input type="date" value={f.end} onChange={set("end")} required />
              </Field>
              {v3 && !market ? <Field label="Review window (days)" hint="Days after the end date in which you can still review and pay. Leave empty for none.">
                <input type="number" min={1} max={60} step={1} value={f.reviewDays} onChange={set("reviewDays")} />
              </Field> : null}
              <Field label={v3 ? "Repositories (optional)" : "Repositories"} hint="owner/name, comma separated" wide>
                <input value={f.repos} onChange={set("repos")} required={!v3} />
              </Field>
            </div>
            <p className="field-hint">{f.workflow === "report_and_invoice" ? "The builder submits a report, invoice and evidence against this scope before review." : "A PR counts when someone other than its author merges it."}</p>
          </section>

          <SignInGate account={f.rep} role="representative" />
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="form-actions">
            <a className="btn btn-ghost btn-md" href="#/">
              Cancel
            </a>
            <Button type="submit" icon="arrowRight" busy={pending}>
              {pending ? "Creating draft…" : "Create draft"}
            </Button>
          </div>
        </form>

        <aside className="split-side">
          <div className="sticky">
            <div className="side-label">Live preview</div>
            {market ? <p className="small">Settled on the Agent Market: no platform agent, policy or payout is created for this job.</p> : <PolicyCard payee={f.payee} scope={f.scope} start={f.start} end={f.end} repos={repos} approver={f.workflow === "report_and_invoice" && f.dao.trim() ? f.dao.trim() : f.rep} standIn={config.platform === "fake"} reportWorkflow={v3} capAtScope={v3} payUntil={payUntil} />}
            <p className="side-note">
              <Icon name="info" size={14} /> {market ? "Both parties sign these terms; the Agent Market holds and releases the awarded price." : <>{config.platform === "fake" ? "On the platform stand-in the locked rows are simulated." : "Locked rows become the MultiAgency platform's policy."} The platform agent is created after both parties sign.</>}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
