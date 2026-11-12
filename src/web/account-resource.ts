export interface ResourceSnapshot<T> {
  scope: string | null;
  value: T | null;
  error: string | null;
  loading: boolean;
}

/** Account-scoped reads: an old account's response can never replace the current account's view. */
export class AccountResource<T> {
  private generation = 0;
  private scope: string | null = null;
  private snapshot: ResourceSnapshot<T> = { scope: null, value: null, error: null, loading: false };
  private listeners = new Set<() => void>();

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  /** Used during render as well as after effects: mismatched private data is hidden immediately. */
  forScope(scope: string | null): ResourceSnapshot<T> {
    return scope !== null && this.snapshot.scope === scope
      ? this.snapshot
      : { scope, value: null, error: null, loading: scope !== null };
  }

  setScope(scope: string | null) {
    if (scope === this.scope) return;
    this.scope = scope;
    this.invalidate();
    this.publish({ scope, value: null, error: null, loading: scope !== null });
  }

  invalidate() { this.generation++; }

  /** Automatic reads never overlap another read; explicit reloads can still supersede an older poll. */
  async refresh(scope: string, read: () => Promise<T>): Promise<void> {
    if (this.snapshot.loading) return;
    await this.load(scope, read, { background: true });
  }

  async load(scope: string, read: () => Promise<T>, { background = false } = {}): Promise<void> {
    if (scope !== this.scope) return;
    const generation = ++this.generation;
    this.publish({ ...this.snapshot, scope, error: null, loading: true });
    try {
      const value = await read();
      if (scope === this.scope && generation === this.generation) this.publish({ scope, value, error: null, loading: false });
    } catch (error) {
      if (scope === this.scope && generation === this.generation) this.publish({
        scope,
        // Keep unfinished forms mounted during a temporary outage. Access refusals always clear private data.
        value: background && transientReadFailure(error) ? this.snapshot.value : null,
        error: error instanceof Error ? error.message : String(error), loading: false,
      });
    }
  }

  private publish(snapshot: ResourceSnapshot<T>) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function transientReadFailure(error: unknown): boolean {
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  if (typeof status === "number") return status === 408 || status === 429 || (status >= 500 && status < 600);
  return error instanceof TypeError;
}
