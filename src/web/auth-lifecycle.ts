interface SignInCallbacks {
  onSuccess: () => void;
  onError: (error: Error) => void;
}

export const AUTH_CHANGE_KEY = "paperwork.auth.changed";

/** Notification only: another tab must read the server session instead of trusting a stored identity. */
export function announceAuthChange() {
  try { localStorage.setItem(AUTH_CHANGE_KEY, crypto.randomUUID()); } catch { /* Focus checks cover unavailable storage. */ }
}

/** A delayed logout must finish before another login can replace the browser's session cookie. */
export class AuthOperationGate {
  private signingOut = false;

  get isSigningOut() { return this.signingOut; }

  async signIn(work: () => Promise<void>): Promise<void> {
    if (this.signingOut) return;
    await work();
  }

  async signOut(work: () => Promise<void>): Promise<void> {
    if (this.signingOut) return;
    this.signingOut = true;
    try { await work(); }
    finally { this.signingOut = false; }
  }
}

/** Await the installed client's callback flow without leaving a promise open if refresh fails. */
export async function signInAndRefresh(
  start: (callbacks: SignInCallbacks) => Promise<void>,
  refresh: () => Promise<void>,
  report: (error: Error) => void,
): Promise<void> {
  let succeeded = false;
  let failed = false;
  try {
    await start({ onSuccess: () => { succeeded = true; }, onError: (error) => { failed = true; report(error); } });
    if (succeeded && !failed) await refresh();
  } catch (error) { report(error instanceof Error ? error : new Error(String(error))); }
}
