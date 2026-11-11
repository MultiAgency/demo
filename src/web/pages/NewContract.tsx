import { useEffect, useState } from "react";
import { DEMO_TERMS } from "../../shared/demo";
import { api, links } from "../api";
import { SignInGate } from "../components/Account";
import { Icon } from "../components/icons";
import { PolicyCard } from "../components/PolicyCard";
import { Alert, Button, usd } from "../components/ui";
import { useSession } from "../session";
import type { AppConfig, Deliverable } from "../types";

interface Form {
  workflow: "report_and_invoice" | "merged_to_default_branch_by_other";
  company: string;
  rep: string;
  contractorName: string;
  github: string;
  contractorAccount: string;
  payee: string;
  start: string;
  end: string;
  repos: string;
  scope: Deliverable[];
}

/** Demo dates relative to today: the 1st of this month to the last day of next month (UTC). */
function demoDates(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10),
    end: new Date(Date.UTC(y, m + 2, 0)).toISOString().slice(0, 10),
  };
}

const initial: Form = {
  workflow: "report_and_invoice",
  company: DEMO_TERMS.company,
  rep: DEMO_TERMS.representative.near_account,
  contractorName: DEMO_TERMS.contractor.name,
  github: DEMO_TERMS.contractor.github,
  contractorAccount: DEMO_TERMS.contractor.near_account,
  payee: DEMO_TERMS.payee.address,
  ...demoDates(),
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
  const [f, setF] = useState<Form>(initial);
  const [error, setError] = useState<string | null>(null);
  const session = useSession();
  // The signed-in NEAR account is the representative by default.
  useEffect(() => {
    if (session.account) setF((x) => ({ ...x, rep: session.account! }));
  }, [session.account]);

  const set = (k: Exclude<keyof Form, "scope">) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const setItem = (i: number, k: keyof Deliverable) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, scope: f.scope.map((d, j) => (j === i ? { ...d, [k]: e.target.value } : d)) });
  const addItem = () => {
    const used = new Set(f.scope.map((d) => d.id));
    const id = Array.from({ length: 10 }, (_, i) => `d${i + 1}`).find((x) => !used.has(x));
    if (id) setF({ ...f, scope: [...f.scope, { id, title: "", criteria: "", value_usd: "" }] });
  };
  const removeItem = (i: number) => setF({ ...f, scope: f.scope.filter((_, j) => j !== i) });
  const repos = f.repos.split(/[\s,]+/).filter(Boolean);
  const total = f.scope.reduce((n, d) => n + (Number(d.value_usd) || 0), 0);

  async function submit() {
    setError(null);
    try {
      const res = await api<{ id: string; contractor_token: string }>("POST", "/contracts", {
        v: f.workflow === "report_and_invoice" ? 3 : 2,
        company: f.company,
        representative: { near_account: f.rep },
        contractor: { name: f.contractorName, github: f.github, near_account: f.contractorAccount },
        payee: { chain: "near", address: f.payee },
        asset: DEMO_TERMS.asset,
        scope: f.scope,
        start: f.start,
        end: f.end,
        repos,
        acceptance: f.workflow,
        ...(f.workflow === "report_and_invoice" ? { payment_terms: { calculation: "scope_completion_less_committed", invoice: "cap", approval: "explicit_agency", settlement: "platform_usdc_near", due: "after_approval" } } : {}),
      });
      links.save(res.id, res.contractor_token);
      window.location.hash = `/c/${res.id}`;
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <a href="#/" className="crumb">
            <Icon name="chevronLeft" size={14} /> Contracts
          </a>
          <h1>New contract</h1>
          <p className="page-sub">Agree the scope, budget and deadline. The agency approves every payout.</p>
        </div>
      </header>

      <div className="split">
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <section className="form-section">
            <h2><Icon name="file" /> Work and payment terms</h2>
            <div className="stack">
              <label className="row gap">
                <input className="job-radio" type="radio" name="workflow" checked={f.workflow === "report_and_invoice"} onChange={() => setF({ ...f, workflow: "report_and_invoice" })} />
                <span><strong>Report and invoice</strong><br /><span className="field-hint">Builder submits evidence. An agent proposes compensation; the agency approves or requests changes.</span></span>
              </label>
              <label className="row gap">
                <input className="job-radio" type="radio" name="workflow" checked={f.workflow === "merged_to_default_branch_by_other"} onChange={() => setF({ ...f, workflow: "merged_to_default_branch_by_other" })} />
                <span><strong>Pay on merge</strong><br /><span className="field-hint">Existing workflow: independently merged PRs are judged against the signed scope.</span></span>
              </label>
              {f.workflow === "report_and_invoice" ? <p className="small">Compensation is the agreed value of completed scope, less amounts already committed, capped by the invoice. Payment follows explicit agency approval, in USDC to the agreed NEAR payee.</p> : null}
            </div>
          </section>
          <section className="form-section">
            <h2>
              <Icon name="building" /> Parties
            </h2>
            <div className="grid2">
              <Field label="Company">
                <input value={f.company} onChange={set("company")} required />
              </Field>
              <Field label="Representative" hint="NEAR account that signs, owns the agent and approves payouts">
                <input value={f.rep} onChange={set("rep")} required />
              </Field>
              <Field label="Contractor">
                <input value={f.contractorName} onChange={set("contractorName")} required />
              </Field>
              <Field label="Contractor's NEAR account">
                <input value={f.contractorAccount} onChange={set("contractorAccount")} required />
              </Field>
              <Field label="GitHub username" hint={f.workflow === "report_and_invoice" ? "Builder identity for supporting code evidence" : "Whose merged PRs count"}>
                <div className="input-affix prefix">
                  <span>@</span>
                  <input value={f.github} onChange={set("github")} required />
                </div>
              </Field>
              <Field label="Payee" hint="The only account the agent can pay">
                <div className="input-affix">
                  <input value={f.payee} onChange={set("payee")} required />
                  <span>USDC · NEAR</span>
                </div>
              </Field>
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
              <Field label="End" hint="Covenant's payout permission ends then">
                <input type="date" value={f.end} onChange={set("end")} required />
              </Field>
              <Field label="Repositories" hint="owner/name, comma separated" wide>
                <input value={f.repos} onChange={set("repos")} required />
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
            <Button type="submit" icon="arrowRight">
              Create draft
            </Button>
          </div>
        </form>

        <aside className="split-side">
          <div className="sticky">
            <div className="side-label">Live preview</div>
            <PolicyCard payee={f.payee} scope={f.scope} start={f.start} end={f.end} repos={repos} approver={f.rep} standIn={config.platform === "fake"} reportWorkflow={f.workflow === "report_and_invoice"} />
            <p className="side-note">
              <Icon name="info" size={14} /> {config.platform === "fake" ? "On the platform stand-in the locked rows are simulated." : "Locked rows become the MultiAgency platform's policy."} Nothing is created until both parties sign.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
