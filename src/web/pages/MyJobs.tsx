import { useCallback } from "react";
import type { JobAttention, MyJob } from "../../shared/my-jobs";
import { jobHref } from "../../shared/job-actions";
import { api } from "../api";
import { Alert, Badge, Button, Card, CardHeader, dateText, Empty, PageLoading, usd } from "../components/ui";
import { useSession } from "../session";
import type { AppConfig } from "../types";
import { useAccountResource } from "../useAccountResource";
import { STAGES } from "./Home";

interface MyJobsResponse { jobs: MyJob[]; demo: boolean }

/** Older running app processes may not yet include the additive next-action projection. */
function recordedAttention(value: unknown): JobAttention {
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if ((row.state === "needs_action" || row.state === "waiting" || row.state === "completed")
      && typeof row.summary === "string" && typeof row.detail === "string" && Array.isArray(row.actions)
      && row.actions.every((action: unknown) => {
        if (!action || typeof action !== "object") return false;
        const item = action as Record<string, unknown>;
        return (item.role === "agency" || item.role === "builder") && typeof item.label === "string";
      })) return value as JobAttention;
  }
  return {
    state: "waiting", summary: "Open job to check status",
    detail: "No next-action information is recorded in this view. Open the existing job to inspect its status.", actions: [],
  };
}

export function MyJobs({ config }: { config: AppConfig }) {
  const session = useSession();
  const read = useCallback(() => api<MyJobsResponse>("GET", "/jobs/mine"), []);
  const resource = useAccountResource("jobs:mine", read, { refreshMs: 5000 });
  if (!resource.enabled) return <div className="page stack">
    <header className="page-header"><div><h1>Assigned to me</h1><p className="page-sub">Jobs where this account is the named builder or agency representative.</p></div></header>
    {session.loading ? <PageLoading /> : <>
      <p>Sign in with NEAR to see jobs where your account is the named builder or agency representative.</p>
      <div><Button icon="key" onClick={session.signIn}>Sign in with NEAR</Button></div>
      {session.error ? <Alert tone="danger">{session.error}</Alert> : null}
      <a href="#/start">Get started</a>
    </>}
  </div>;
  if (!resource.value) return resource.error
    ? <div className="page stack"><h1>Assigned to me</h1><Alert tone="danger">{resource.error}</Alert><div><Button variant="secondary" onClick={resource.reload}>Retry loading jobs</Button></div></div>
    : <PageLoading />;
  return <MyJobsContent jobs={resource.value.jobs} demo={resource.value.demo || !config.auth.required} error={resource.error} reload={resource.reload} />;
}

/** Summary presentation only. Opening a record never creates an invitation, signature or payment. */
export function MyJobsContent({ jobs, demo, error = null, reload }: {
  jobs: MyJob[]; demo: boolean; error?: string | null; reload: () => Promise<void>;
}) {
  return <div className="page stack">
    <header className="page-header">
      <div><h1>Assigned to me</h1><p className="page-sub">Jobs where this account is the named builder or agency representative.</p></div>
      <div className="header-actions"><Button variant="secondary" size="sm" onClick={reload}>Refresh jobs</Button><a className="btn btn-secondary btn-sm" href="#/start">Get started</a></div>
    </header>
    {demo ? <Alert tone="warning">Keyless demonstration: showing simulated account-scoped jobs. Submitting work still requires the agency's original private invitation link, including after acceptance.</Alert> : null}
    {error ? <Alert tone="warning">Your jobs could not refresh. Showing the last loaded jobs and recorded actions; they may be out of date. {error}</Alert> : null}
    {!jobs.length && !error ? <Empty icon="file" title="No jobs for this account yet" sub="Apply to a published opening, or ask the agency to name this account in its offer." action={<a className="btn btn-primary btn-sm" href="#/start">Get started</a>} /> : null}
    {([
      ["needs_action", "Needs your action"], ["waiting", "Waiting"], ["completed", "Completed"],
    ] as const).map(([state, label]) => {
      const rows = jobs.filter((job) => recordedAttention(job.attention).state === state);
      return rows.length ? <section className="stack" key={state} aria-labelledby={`my-jobs-${state}`}>
        <h2 id={`my-jobs-${state}`}>{label}</h2>
        {rows.map((job) => <MyJobCard key={job.id} job={job} demo={demo} />)}
      </section> : null;
    })}
  </div>;
}

function MyJobCard({ job, demo }: { job: MyJob; demo: boolean }) {
  const stage = STAGES[job.stage];
  const base = jobHref(job.id, "agency");
  const attention = recordedAttention(job.attention);
  const agencyAction = attention.actions.find((action) => action.role === "agency");
  const builderAction = attention.actions.find((action) => action.role === "builder");
  return <Card>
    <CardHeader title={<span style={{ overflowWrap: "anywhere" }}>{job.title}</span>} sub={`${job.company} · ${job.builder_name}`} />
    <div className="stack">
      <div><strong>{attention.summary}</strong><p className="small muted">{attention.detail}</p></div>
      <div className="title-row">
        {job.roles.map((role) => <Badge key={role} tone="neutral">{role === "agency" ? "Agency" : "Builder"}</Badge>)}
        <span className="small muted">{job.workflow === "report_invoice" ? "Report and invoice" : "Pay on merge"}</span>
      </div>
      <div className="title-row small muted"><span>Scope {usd(job.scope_usd)}</span><span>Setup: {stage?.label ?? job.stage}</span><span>Starts {dateText(job.start)}</span><span>Deadline {dateText(job.end)}</span></div>
      {demo && job.roles.includes("builder") && !job.builder_accepted ? <Alert tone="info">To accept this job in the keyless demonstration, open the agency's original private invitation link.</Alert> : null}
      <div className="header-actions">
        {job.roles.includes("agency") ? <a className={`btn btn-${agencyAction ? "primary" : "secondary"} btn-sm`} href={base}>{agencyAction?.label ?? "Open agency view"}</a> : null}
        {job.roles.includes("builder") ? <a className={`btn btn-${builderAction && (job.builder_accepted || !demo) ? "primary" : "secondary"} btn-sm`} href={jobHref(job.id, "builder")}>{job.builder_accepted ? builderAction?.label ?? "Open builder view" : demo ? "View offered terms" : "Review and sign terms"}</a> : null}
      </div>
    </div>
  </Card>;
}
