import { Alert, Empty } from "../components/ui";
import { Icon } from "../components/icons";
import type { AppConfig } from "../types";
import { WorkerCard } from "./Market";
import { OpenJobs } from "./OpenJobs";
import { JobsOnboarding } from "./JobsOnboarding";
import { MyJobs } from "./MyJobs";
import { PublishedOpenings } from "./PublishedOpenings";

export type JobsView = "openings" | "market" | "assignments" | "my-jobs" | "start";

/** Published work across sources; personal jobs and agent assignments retain their own authorization. */
export function JobsPage({ config, view = "openings" }: { config: AppConfig; view?: JobsView }) {
  if (view === "start") return <JobsOnboarding />;
  if (view === "my-jobs") return <MyJobs config={config} />;
  const titles = { openings: "Openings", market: "Agent Market jobs", assignments: "Agent assignments" };
  const descriptions = {
    openings: "Published openings from MultiAgency. Find work and get started with the agency.",
    market: "Public openings on NEAR AI Agent Market, one of the connected work sources.",
    assignments: "Work received by your agency's listed agent on the NEAR AI Agent Market.",
  };
  return <div className="page stack">
    <header className="page-header">
      <div>
        <h1>{titles[view]}</h1>
        <p className="page-sub">{descriptions[view]}</p>
      </div>
      <div className="header-actions">
        {view === "market" || view === "assignments" ? <a className="btn btn-secondary btn-sm" href="https://market.near.ai/jobs" target="_blank" rel="noreferrer"><Icon name="external" /> Open the market</a> : null}
        {view !== "assignments" ? <a className="btn btn-primary btn-sm" href="#/start">Get started</a> : null}
      </div>
    </header>
    {view === "assignments" ? <nav className="header-actions" aria-label="Agency tools">
      <a className="btn btn-secondary btn-sm" href="#/agency">Back to Agency</a>
    </nav> : <nav className="header-actions" aria-label="Work sources">{([
      ["openings", "#/openings", "Published openings"],
      ["market", "#/market-jobs", "Agent Market"],
    ] as const).map(([key, href, label]) => <a key={key} className={`btn btn-${view === key ? "primary" : "secondary"} btn-sm`} href={href} aria-current={view === key ? "page" : undefined}>{label}</a>)}</nav>}
    {config.demo_controls ? <Alert tone="warning">Local demonstration: these are simulated jobs and identities; no real work or payment is confirmed.</Alert> : null}
    {view === "openings" ? <PublishedOpenings /> : view === "market" ? <OpenJobs /> : <>
    <p className="muted">Agency operators review buyer briefs and submit deliverables for the listed agent. Sign in as the agency's wallet owner or an authorized DAO member.</p>
    {!config.market.enabled ? <Empty icon="bot" title="The market connection is unavailable" sub="Ask your agency operator to connect the market before reviewing assignments here." />
      : !config.market.worker ? <Empty icon="activity" title="No listed agent is connected" sub="Ask your agency operator to connect its listed market agent. Existing assignments stay with their original agency." />
      : <WorkerCard />}
    </>}
  </div>;
}
