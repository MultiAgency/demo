interface SignInCallbacks {
  onSuccess: () => void;
  onError: (error: Error) => void;
}

/** A delayed logout must finish before another login can replace the browser's session cookie. */
export class AuthOperationGate {
  private signingOut = false;

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
