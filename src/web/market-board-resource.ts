import type { BoardJob, OpenJobsPage } from "../shared/market-board";

export interface BoardQuery { q: string; kind: "" | BoardJob["kind"]; sort: "recent" | "budget" }
export const INITIAL_BOARD_QUERY: BoardQuery = { q: "", kind: "", sort: "recent" };
export interface BoardSnapshot {
  query: BoardQuery;
  loaded_query: BoardQuery | null;
  jobs: BoardJob[];
  next_offset: number | null;
  checked_at: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
}
export const sameBoardQuery = (a: BoardQuery, b: BoardQuery | null) => b !== null && a.q === b.q && a.kind === b.kind && a.sort === b.sort;

/** Public board reads: a later search wins, and a failed read never turns loaded results into an empty board. */
export class MarketBoardResource {
  private generation = 0;
  private listeners = new Set<() => void>();
  private snapshot: BoardSnapshot = { query: { ...INITIAL_BOARD_QUERY }, loaded_query: null, jobs: [], next_offset: null, checked_at: null, loaded: false, loading: false, error: null };
  constructor(private read: (query: BoardQuery, offset: number) => Promise<OpenJobsPage>) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  invalidate() { this.generation++; }

  search(query: BoardQuery = this.snapshot.query): Promise<void> {
    return this.load({ ...query, q: query.q.trim() }, 0, false);
  }

  async more(): Promise<void> {
    if (this.snapshot.loading || this.snapshot.next_offset === null || !sameBoardQuery(this.snapshot.query, this.snapshot.loaded_query)) return;
    await this.load(this.snapshot.query, this.snapshot.next_offset, true);
  }

  private async load(query: BoardQuery, offset: number, append: boolean) {
    const generation = ++this.generation;
    const prior = this.snapshot;
    this.publish({ ...prior, query, loading: true, error: null });
    try {
      const page = await this.read(query, offset);
      if (generation !== this.generation) return;
      if (page.offset !== offset || !Array.isArray(page.jobs) || (page.next_offset !== null && (!Number.isSafeInteger(page.next_offset) || page.next_offset <= offset)))
        throw new Error("The market returned invalid pagination. Refresh the jobs to try again.");
      const jobs = new Map<string, BoardJob>();
      for (const job of [...(append ? prior.jobs : []), ...page.jobs]) {
        if (job.status === "open" || job.status === "filling") jobs.set(job.job_id, job);
      }
      this.publish({ query, loaded_query: query, jobs: [...jobs.values()], next_offset: page.next_offset, checked_at: page.checked_at, loaded: true, loading: false, error: null });
    } catch (error) {
      if (generation === this.generation) this.publish({ ...this.snapshot, loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private publish(snapshot: BoardSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
