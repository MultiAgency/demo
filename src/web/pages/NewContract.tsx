import { useState } from "react";
import { DEMO_TERMS } from "../../shared/demo";
import { api, links } from "../api";
import { Button, ErrorText, GuidePanel } from "../components/ui";

interface Form {
  company: string;
  rep: string;
  contractorName: string;
  github: string;
  contractorAccount: string;
  payee: string;
  cap: string;
  rate: string;
  start: string;
  end: string;
  repos: string;
  scope: string;
}

/** Demo dates relative to today: from the 1st of this month to the last day of next month (UTC). */
function demoDates(now = new Date()): { start: string; end: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 2, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

const initial: Form = {
  company: DEMO_TERMS.company,
  rep: DEMO_TERMS.representative.near_account,
  contractorName: DEMO_TERMS.contractor.name,
  github: DEMO_TERMS.contractor.github,
  contractorAccount: DEMO_TERMS.contractor.near_account,
  payee: DEMO_TERMS.payee.address,
  cap: DEMO_TERMS.monthly_cap_usd,
  rate: DEMO_TERMS.rate_per_accepted_pr_usd,
  ...demoDates(),
  repos: DEMO_TERMS.repos.join(", "),
  scope: DEMO_TERMS.scope,
};

export function NewContract() {
  const [f, setF] = useState<Form>(initial);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  async function submit() {
    setError(null);
    try {
      const res = await api<{ id: string; contractor_token: string }>("POST", "/contracts", {
        v: 1,
        company: f.company,
        representative: { near_account: f.rep },
        contractor: { name: f.contractorName, github: f.github, near_account: f.contractorAccount },
        payee: { chain: "near", address: f.payee },
        asset: DEMO_TERMS.asset,
        monthly_cap_usd: f.cap,
        rate_per_accepted_pr_usd: f.rate,
        start: f.start,
        end: f.end,
        repos: f.repos.split(/[\s,]+/).filter(Boolean),
        scope: f.scope,
        acceptance: "merged_to_default_branch_by_other",
      });
      links.save(res.id, res.contractor_token);
      window.location.hash = `/c/${res.id}`;
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="container wizard-layout">
      <div className="wizard-main">
        <p className="eyebrow">Step 1 of 9</p>
        <h1>Draft the work order</h1>
        <p className="muted">The demo values are filled in. Change anything you like; the simulator's demo wallet can sign for acme.demo and maria.demo.</p>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset>
            <legend>Company</legend>
            <label>
              Company name
              <input value={f.company} onChange={set("company")} required />
            </label>
            <label>
              Representative's NEAR account <small>signs the terms and owns the contract wallet</small>
              <input value={f.rep} onChange={set("rep")} required />
            </label>
          </fieldset>
          <fieldset>
            <legend>Contractor</legend>
            <label>
              Name
              <input value={f.contractorName} onChange={set("contractorName")} required />
            </label>
            <div className="row2">
              <label>
                GitHub username <small>whose merged PRs count</small>
                <input value={f.github} onChange={set("github")} required />
              </label>
              <label>
                NEAR account <small>signs the terms</small>
                <input value={f.contractorAccount} onChange={set("contractorAccount")} required />
              </label>
            </div>
            <label>
              Payee (NEAR account that receives USDC) <small>the only address the wallet can ever pay</small>
              <input value={f.payee} onChange={set("payee")} required />
            </label>
          </fieldset>
          <fieldset>
            <legend>Money and term</legend>
            <div className="row2">
              <label>
                Monthly cap (USD) <small>the most it can pay in a month</small>
                <input value={f.cap} onChange={set("cap")} inputMode="decimal" required />
              </label>
              <label>
                Rate per accepted PR (USD)
                <input value={f.rate} onChange={set("rate")} inputMode="decimal" required />
              </label>
            </div>
            <div className="row2">
              <label>
                Start date
                <input type="date" value={f.start} onChange={set("start")} required />
              </label>
              <label>
                End date <small>after this, the agent's permission expires</small>
                <input type="date" value={f.end} onChange={set("end")} required />
              </label>
            </div>
          </fieldset>
          <fieldset>
            <legend>Work</legend>
            <label>
              Repositories <small>owner/name, comma separated</small>
              <input value={f.repos} onChange={set("repos")} required />
            </label>
            <label>
              Scope of work <small>what the agent's reviewer judges PRs against</small>
              <textarea rows={3} value={f.scope} onChange={set("scope")} required />
            </label>
            <p className="hint">Acceptance rule: a PR counts when someone other than its author merges it into the default branch.</p>
          </fieldset>
          <ErrorText error={error} />
          <div className="form-actions">
            <Button type="submit">Create draft and continue →</Button>
          </div>
        </form>
      </div>
      <GuidePanel step="draft" />
    </div>
  );
}
