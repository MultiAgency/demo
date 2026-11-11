import { expect, test } from "bun:test";
import { AccountResource } from "../src/web/account-resource";
import { AuthOperationGate, signInAndRefresh } from "../src/web/auth-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("a changed render scope hides the prior account's loaded data before effects run", async () => {
  const resource = new AccountResource<string>();
  resource.setScope("agency.near");
  await resource.load("agency.near", async () => "private agency report");
  expect(resource.forScope("agency.near").value).toBe("private agency report");
  expect(resource.forScope("builder.near").value).toBeNull();
  expect(resource.forScope(null).value).toBeNull();
});

test("signout discards a late private response and does not repopulate an anonymous view", async () => {
  const resource = new AccountResource<string>();
  const slow = deferred<string>();
  resource.setScope("agency.near");
  const pending = resource.load("agency.near", () => slow.promise);
  resource.setScope(null);
  slow.resolve("private agency report");
  await pending;
  expect(resource.getSnapshot()).toEqual({ scope: null, value: null, error: null, loading: false });
});

test("account switch ignores a late prior-account success and error", async () => {
  const resource = new AccountResource<string>();
  const old = deferred<string>();
  resource.setScope("agency.near");
  const pending = resource.load("agency.near", () => old.promise);
  resource.setScope("builder.near");
  await resource.load("builder.near", async () => "builder report");
  old.resolve("agency report");
  await pending;
  expect(resource.forScope("builder.near").value).toBe("builder report");

  const failing = deferred<string>();
  const another = resource.load("builder.near", () => failing.promise);
  resource.setScope("another.near");
  await resource.load("another.near", async () => "another report");
  failing.reject(new Error("private builder diagnostic"));
  await another;
  expect(resource.forScope("another.near").value).toBe("another report");
  expect(resource.forScope("another.near").error).toBeNull();
});

test("only the latest read wins for one account; stale reload callbacks cannot read another account", async () => {
  const resource = new AccountResource<string>();
  const old = deferred<string>();
  resource.setScope("agency.near");
  const pending = resource.load("agency.near", () => old.promise);
  await resource.load("agency.near", async () => "new report");
  old.resolve("old report");
  await pending;
  expect(resource.forScope("agency.near").value).toBe("new report");
  resource.setScope("builder.near");
  let called = false;
  await resource.load("agency.near", async () => { called = true; return "wrong actor"; });
  expect(called).toBe(false);
  expect(resource.forScope("builder.near").value).toBeNull();
});

test("an expired-session read clears private data and an explicit reload can recover", async () => {
  const resource = new AccountResource<string>();
  resource.setScope("agency.near");
  await resource.load("agency.near", async () => "private report");
  await resource.load("agency.near", async () => { throw new Error("Sign in as a party to this work order."); });
  expect(resource.forScope("agency.near").value).toBeNull();
  expect(resource.forScope("agency.near").error).toContain("Sign in");
  expect(resource.forScope("agency.near").loading).toBe(false);
  await resource.load("agency.near", async () => "recovered report");
  expect(resource.forScope("agency.near").value).toBe("recovered report");
  expect(resource.forScope("agency.near").error).toBeNull();
});

test("sign-in refresh rejection settles and reports the error instead of hanging the sign-in button", async () => {
  const errors: string[] = [];
  await signInAndRefresh(async (callbacks) => callbacks.onSuccess(), async () => { throw new Error("Session refresh unavailable"); }, (error) => errors.push(error.message));
  expect(errors).toEqual(["Session refresh unavailable"]);
});

test("cancelled or unexpectedly rejected sign-in settles without refreshing a session", async () => {
  const errors: string[] = [];
  let refreshed = 0;
  const refresh = async () => { refreshed++; };
  await signInAndRefresh(async (callbacks) => callbacks.onError(new Error("Wallet cancelled")), refresh, (error) => errors.push(error.message));
  await signInAndRefresh(async () => { throw new Error("Wallet unavailable"); }, refresh, (error) => errors.push(error.message));
  expect(refreshed).toBe(0);
  expect(errors).toEqual(["Wallet cancelled", "Wallet unavailable"]);
});

test("a new login cannot race a deferred wallet disconnect or server logout and lose its session", async () => {
  const gate = new AuthOperationGate();
  const disconnect = deferred<void>();
  const logoutResponse = deferred<void>();
  let sessionCookie: string | null = "agency.near";
  let privateViewVisible = true;
  let logoutStarted = false;
  let loginCalls = 0;
  const loginAsBuilder = () => gate.signIn(async () => { loginCalls++; sessionCookie = "builder.near"; });
  const pendingLogout = gate.signOut(async () => {
    privateViewVisible = false;
    await disconnect.promise;
    logoutStarted = true;
    await logoutResponse.promise;
    sessionCookie = null;
  });
  expect(privateViewVisible).toBe(false);
  // The guard is synchronous, before React can render the loading state.
  await loginAsBuilder();
  expect(loginCalls).toBe(0);
  expect(sessionCookie).toBe("agency.near");
  disconnect.resolve(undefined);
  await Promise.resolve();
  expect(logoutStarted).toBe(true);
  await loginAsBuilder();
  expect(loginCalls).toBe(0);
  logoutResponse.resolve(undefined);
  await pendingLogout;
  expect(sessionCookie).toBeNull();
  await loginAsBuilder();
  expect(loginCalls).toBe(1);
  expect(sessionCookie).toBe("builder.near");
});

test("duplicate logout is ignored while pending and a failed logout releases the login guard", async () => {
  const gate = new AuthOperationGate();
  const response = deferred<void>();
  let logoutCalls = 0;
  const pending = gate.signOut(async () => { logoutCalls++; await response.promise; });
  await gate.signOut(async () => { logoutCalls++; });
  expect(logoutCalls).toBe(1);
  response.reject(new Error("Logout unavailable"));
  await expect(pending).rejects.toThrow("Logout unavailable");
  let loggedIn = false;
  await gate.signIn(async () => { loggedIn = true; });
  expect(loggedIn).toBe(true);
});
