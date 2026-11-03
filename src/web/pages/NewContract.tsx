import { useEffect, useState } from "react";
import { DEMO_TERMS } from "../../shared/demo";
import { api, links } from "../api";
import { Icon } from "../components/icons";
import { PolicyCard } from "../components/PolicyCard";
import { SignInGate } from "../components/Account";
import { useSession } from "../session";
import { Alert, Button } from "../components/ui";
import type { AppConfig } from "../types";

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
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const repos = f.repos.split(/[\s,]+/).filter(Boolean);

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
        repos,
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
    <div className="page">
      <header className="page-header">
        <div>
          <a href="#/" className="crumb">
            <Icon name="chevronLeft" size={14} /> Contracts
          </a>
          <h1>New contract</h1>
          <p className="page-sub">Fill in the terms. The preview shows the wallet they compile to.</p>
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
            <h2>
              <Icon name="building" /> Parties
            </h2>
            <div className="grid2">
              <Field label="Company">
                <input value={f.company} onChange={set("company")} required />
              </Field>
              <Field label="Representative" hint="NEAR account that signs and owns the wallet">
                <input value={f.rep} onChange={set("rep")} required />
              </Field>
              <Field label="Contractor">
                <input value={f.contractorName} onChange={set("contractorName")} required />
              </Field>
              <Field label="Contractor's NEAR account">
                <input value={f.contractorAccount} onChange={set("contractorAccount")} required />
              </Field>
            </div>
          </section>

          <section className="form-section">
            <h2>
              <Icon name="coins" /> Payment
            </h2>
            <div className="grid2">
              <Field label="Payee" hint="The only account this wallet can pay" wide>
                <div className="input-affix">
                  <input value={f.payee} onChange={set("payee")} required />
                  <span>USDC · NEAR</span>
                </div>
              </Field>
              <Field label="Monthly limit">
                <div className="input-affix prefix">
                  <span>$</span>
                  <input value={f.cap} onChange={set("cap")} inputMode="decimal" required />
                </div>
              </Field>
              <Field label="Per merged PR">
                <div className="input-affix prefix">
                  <span>$</span>
                  <input value={f.rate} onChange={set("rate")} inputMode="decimal" required />
                </div>
              </Field>
              <Field label="Start">
                <input type="date" value={f.start} onChange={set("start")} required />
              </Field>
              <Field label="End" hint="The agent's permission expires then">
                <input type="date" value={f.end} onChange={set("end")} required />
              </Field>
            </div>
          </section>

          <section className="form-section">
            <h2>
              <Icon name="pr" /> Work
            </h2>
            <div className="grid2">
              <Field label="GitHub username">
                <div className="input-affix prefix">
                  <span>@</span>
                  <input value={f.github} onChange={set("github")} required />
                </div>
              </Field>
              <Field label="Repositories" hint="owner/name, comma separated">
                <input value={f.repos} onChange={set("repos")} required />
              </Field>
              <Field label="Scope" wide>
                <textarea rows={2} value={f.scope} onChange={set("scope")} required />
              </Field>
            </div>
            <p className="field-hint">A PR counts when someone other than its author merges it.</p>
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
            <PolicyCard payee={f.payee} cap={f.cap} rate={f.rate} start={f.start} end={f.end} repos={repos} timelockMinutes={Math.round(config.timelock_ms / 60000)} />
            <p className="side-note">
              <Icon name="info" size={14} /> Locked rows are enforced by NEAR Intents. Nothing is created until both parties sign.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
