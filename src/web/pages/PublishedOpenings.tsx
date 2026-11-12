import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { PublishedOpening, PublicOpenings } from "../../shared/job-openings";
import { AccountResource } from "../account-resource";
import { api } from "../api";
import { Alert, Badge, Button, Card, CardHeader, dateText, Empty, PageLoading, timeText } from "../components/ui";

const scope = "public:multiagency-openings";
const read = () => api<PublicOpenings>("GET", "/jobs/openings");
const fallback = "https://nearn.io/multiagency/";
export function publishedOpeningUrl(value: string): string {
  const url = URL.canParse(value) ? new URL(value) : null;
  return url?.origin === "https://nearn.io" && !url.username && !url.password && !url.search && !url.hash
    && /^\/(?:listing\/)?[a-z0-9_-]+\/?$/i.test(url.pathname) ? url.href : fallback;
}

export function openingCompensation(job: PublishedOpening): string {
  const token = job.budget_token;
  if (!token) return "See compensation terms in listing";
  if (job.compensation_type === "variable") return job.budget_amount === null
    ? "Variable compensation; see listing" : `Variable · up to ${job.budget_amount} ${token}`;
  if (job.compensation_type === "range") return job.minimum_reward != null && job.maximum_reward != null
    ? `${job.minimum_reward}–${job.maximum_reward} ${token}` : "Compensation range in listing";
  if (job.compensation_type === "fixed" && job.budget_amount !== null) return job.kind === "bounty" || job.kind === "hackathon"
    ? `Advertised prize budget: ${job.budget_amount} ${token}` : `Advertised amount: ${job.budget_amount} ${token}`;
  return "See compensation terms in listing";
}

export function PublishedOpenings() {
  const resource = useMemo(() => new AccountResource<PublicOpenings>(), []);
  useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  useEffect(() => {
    resource.setScope(scope);
    void resource.load(scope, read);
    return () => resource.invalidate();
  }, [resource]);
  const refresh = useCallback(() => resource.refresh(scope, read), [resource]);
  const state = resource.forScope(scope);
  return <PublishedOpeningsContent data={state.value} error={state.error} loading={state.loading} refresh={refresh} />;
}

export function PublishedOpeningsContent({ data, error, loading, refresh }: {
  data: PublicOpenings | null; error: string | null; loading: boolean; refresh: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(50);
  const matching = data?.openings.filter((job) => `${job.title} ${job.kind}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  return <div className="stack">
    <div className="header-actions">
      <Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>Refresh openings</Button>
      <a className="btn btn-secondary btn-sm" href={publishedOpeningUrl(data?.source_url ?? fallback)} target="_blank" rel="noopener noreferrer">View MultiAgency listings</a>
    </div>
    <p className="muted">Only published openings accepting applications appear here. Private signed jobs are in <a href="#/my-jobs">Assigned to me</a>; active projects without an opening are excluded.</p>
    {error ? <Alert tone="warning">{data ? "Openings could not refresh. Showing the last loaded openings." : "Published openings could not be loaded."} {error}</Alert> : null}
    {!data && loading ? <PageLoading /> : null}
    {data ? <>
      <label className="field"><span className="field-label">Search MultiAgency openings</span><input value={query} onChange={(event) => { setQuery(event.target.value); setVisible(50); }} placeholder="Title or type of work" /></label>
      <p className="small muted" role="status" aria-live="polite">{Math.min(visible, matching.length)} of {matching.length} published openings · checked {timeText(data.checked_at)}</p>
      {matching.slice(0, visible).map((job) => <Card key={job.id}>
        <CardHeader title={<span style={{ overflowWrap: "anywhere" }}>{job.title}</span>} sub="MultiAgency · NEARN" actions={<Badge tone="info">{job.kind}</Badge>} />
        <div className="stack">
          <div className="title-row"><strong>{openingCompensation(job)}</strong><span className="small muted">{job.deadline ? `Listing deadline ${dateText(job.deadline, true)}` : "See listing for application terms"}</span></div>
          <div className="header-actions"><a className="btn btn-primary btn-sm" href={publishedOpeningUrl(job.url)} target="_blank" rel="noopener noreferrer">{new URL(publishedOpeningUrl(job.url)).pathname.startsWith("/listing/") ? "Review listing" : "View MultiAgency listings"}</a><a href="#/start">How to get started</a></div>
        </div>
      </Card>)}
      {matching.length > visible ? <div><Button variant="secondary" onClick={() => setVisible((count) => count + 50)}>Show more openings</Button></div> : null}
      {!matching.length && !error ? <Empty icon="file" title={query ? "No openings match your search" : "No published openings right now"} sub={query ? "Try a different title or type of work." : "You can introduce yourself to MultiAgency or return to your existing private jobs."} action={<a className="btn btn-primary btn-sm" href="#/start">Get started</a>} /> : null}
    </> : null}
  </div>;
}
