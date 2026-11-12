import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { BoardJob, OpenJobsPage } from "../../shared/market-board";
import { api } from "../api";
import { Alert, Badge, Button, Card, CardHeader, dateText, Disclosure, Empty, Mono, timeText } from "../components/ui";
import { INITIAL_BOARD_QUERY, MarketBoardResource, sameBoardQuery, type BoardQuery, type BoardSnapshot } from "../market-board-resource";

const MARKET_HOME = "https://market.near.ai/jobs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const marketJobUrl = (id: string) => UUID.test(id) ? `${MARKET_HOME}/${encodeURIComponent(id)}` : MARKET_HOME;
async function readBoard(query: BoardQuery, offset: number): Promise<OpenJobsPage> {
  const params = new URLSearchParams({ sort: query.sort, offset: String(offset) });
  if (query.q) params.set("q", query.q);
  if (query.kind) params.set("kind", query.kind);
  return api("GET", `/market/jobs?${params}`);
}

export function OpenJobs() {
  const resource = useMemo(() => new MarketBoardResource(readBoard), []);
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  useEffect(() => { void resource.search(); return () => resource.invalidate(); }, [resource]);
  return <OpenJobsContent snapshot={snapshot} search={(query) => resource.search(query)} refresh={() => resource.search()} more={() => resource.more()} />;
}

export function OpenJobsContent({ snapshot, search, refresh, more }: {
  snapshot: BoardSnapshot; search: (query: BoardQuery) => Promise<void>; refresh: () => Promise<void>; more: () => Promise<void>;
}) {
  const [query, setQuery] = useState<BoardQuery>({ ...INITIAL_BOARD_QUERY });
  const canMore = snapshot.next_offset !== null && sameBoardQuery(snapshot.query, snapshot.loaded_query);
  return <div className="stack">
    <Card>
      <CardHeader title="Find open work" sub="Public market postings. Review current terms and submit bids on Market." actions={<Button variant="secondary" size="sm" onClick={refresh} disabled={snapshot.loading}>Refresh jobs</Button>} />
      <form className="stack" onSubmit={(event) => { event.preventDefault(); void search(query); }}>
        <label className="field"><span className="field-label">Search open jobs</span><input value={query.q} onChange={(event) => setQuery({ ...query, q: event.target.value })} placeholder="Title, description or skills" /></label>
        <div className="grid2">
          <label className="field"><span className="field-label">Job type</span><select value={query.kind} onChange={(event) => setQuery({ ...query, kind: event.target.value as BoardQuery["kind"] })}>
            <option value="">All types</option><option value="standard">Standard</option><option value="instant">Instant</option><option value="competition">Competition</option>
          </select></label>
          <label className="field"><span className="field-label">Sort jobs</span><select value={query.sort} onChange={(event) => setQuery({ ...query, sort: event.target.value as BoardQuery["sort"] })}>
            <option value="recent">Most recent</option><option value="budget">Highest budget</option>
          </select></label>
        </div>
        <div><Button type="submit">Search jobs</Button></div>
      </form>
    </Card>
    {snapshot.error ? <Alert tone="warning">{snapshot.loaded ? "Jobs could not refresh. Showing the last loaded results." : "Open jobs could not be loaded."} {snapshot.error}</Alert> : null}
    <p className="small muted" role="status" aria-live="polite">{snapshot.loading ? "Loading jobs… " : ""}{snapshot.loaded ? `${snapshot.jobs.length} ${snapshot.jobs.length === 1 ? "job" : "jobs"} loaded` : ""}{snapshot.checked_at ? ` · checked ${timeText(snapshot.checked_at)}` : ""}</p>
    {!snapshot.loading && !snapshot.error && snapshot.loaded && snapshot.jobs.length === 0 && snapshot.next_offset === null ? <Empty icon="file" title="No open jobs match these filters" sub="Try another search or check the market again later." /> : null}
    {snapshot.jobs.map((job) => <OpenJobCard key={job.job_id} job={job} />)}
    {canMore ? <div><Button variant="secondary" onClick={more} disabled={snapshot.loading}>Load more</Button></div> : null}
  </div>;
}

export function OpenJobCard({ job }: { job: BoardJob }) {
  return <Card>
    <CardHeader title={<span style={{ overflowWrap: "anywhere" }}>{job.title}</span>} sub={job.creator_name ? `Posted by ${job.creator_name}` : undefined} actions={<Badge tone="info">{job.kind === "standard" ? "Standard" : job.kind === "instant" ? "Instant" : "Competition"}</Badge>} />
    <div className="stack">
      <div className="title-row">
        {job.budget_amount !== null ? <strong>{job.budget_amount} {job.budget_token}</strong> : <span className="muted">Budget on Market</span>}
        <span className="small muted">{job.slots_available} of {job.max_slots} slots available</span>
        <span className="small muted">Posted {dateText(job.posted_at)}</span>
      </div>
      {job.tags.length ? <div className="title-row">{job.tags.map((tag) => <Badge key={tag} tone="neutral">{tag}</Badge>)}</div> : null}
      <Disclosure label="Job description"><pre className="data-text">{job.description}</pre></Disclosure>
      <div className="small muted">
        <p>Minimum verification: {job.minimum_verification === "none" ? "None" : job.minimum_verification === "verified" ? "Verified" : "Identity verified"}. Review the market's terms before bidding.</p>
        {job.acceptance_window_days > 0 ? <p>Acceptance window: {job.acceptance_window_days} days.</p> : null}
        {job.entries_close_at ? <p>Entries close {dateText(job.entries_close_at, true)}.</p> : null}
      </div>
      <div className="header-actions"><a className="btn btn-secondary btn-sm" href={marketJobUrl(job.job_id)} target="_blank" rel="noopener noreferrer">{UUID.test(job.job_id) ? "View job on Market" : "Open Market"}</a><Mono copy={job.job_id}>{job.job_id}</Mono></div>
    </div>
  </Card>;
}
