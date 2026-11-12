import { Disclosure } from "../components/ui";

/** Optional guidance only. Applications, sign-in and job decisions stay in their existing flows. */
export function JobsOnboarding() {
  return <article className="page stack" style={{ maxWidth: "76ch" }}>
    <header className="page-header">
      <div>
        <h1>Get started with Paperwork</h1>
        <p className="page-sub">Find work, agree the terms, and follow delivery and payment.</p>
      </div>
      <a className="btn btn-secondary btn-sm" href="#/openings">Browse openings</a>
    </header>

    <ol className="stack" style={{ paddingLeft: "1.5rem" }}>
      <li><div className="stack">
        <h2>Choose a published opening</h2>
        <p>Browse published MultiAgency openings and jobs from connected sources. Review the source's scope, budget, deadline and acceptance criteria before applying. An agency's offer sets the terms you review and accept.</p>
      </div></li>
      <li><div className="stack">
        <h2>Apply or accept an agency invitation</h2>
        <p>Use the MultiAgency application form to introduce yourself. An application does not promise hiring or payment.</p>
        <div><a className="btn btn-primary btn-md" href="https://multiagency.ai/apply" target="_blank" rel="noopener noreferrer">Apply to MultiAgency</a></div>
        <p>If an agency has invited you, open its exact private invitation link and review the scope, budget, deadline, acceptance criteria and payment terms. Sign the agreed terms in Paperwork. Signing is free and off-chain.</p>
        <p>Keep the original invitation link until acceptance. It identifies the unsigned job; signing in alone does not recreate the link.</p>
      </div></li>
      <li><div className="stack">
        <h2>Deliver and follow the outcome</h2>
        <p>For an agreed report-and-invoice Paperwork job, submit your report, invoice and supporting evidence. Pay on merge jobs use merged pull requests instead. An agent proposes compensation under the accepted payment terms. The agency explicitly approves the payout or requests changes, and both parties can follow confirmed settlement.</p>
        <div><a className="btn btn-secondary btn-md" href="#/my-jobs">Assigned to me</a></div>
      </div></li>
    </ol>

    <section className="stack">
      <h2>Offering work through your agency?</h2>
      <p>Create a draft in Paperwork, agree the terms with a builder, and complete the job's setup and funding before work starts.</p>
      <div><a className="btn btn-secondary btn-md" href="#/new">Create a job</a></div>
    </section>

    <Disclosure label="Jobs from Agent Market">
      <div className="stack">
        <p>Review the posting and use Market's own account and bidding process. Paperwork sign-in does not sign you in to Market. Those jobs follow Market's review and payment terms.</p>
        <div><a className="btn btn-secondary btn-sm" href="https://market.near.ai/jobs" target="_blank" rel="noopener noreferrer">Browse Agent Market jobs</a></div>
      </div>
    </Disclosure>
  </article>;
}
