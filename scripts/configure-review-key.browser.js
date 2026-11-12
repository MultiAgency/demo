/*
 * Manual setup helper: copy this file into the developer console of your own
 * signed-in Multi dashboard. It asks for the already-generated review key.
 * It never prints the key or stores it in browser storage. Only the named
 * profile's API_SERVER_KEY is sent to the existing profile-scoped env API.
 * It does not change enabled/bind settings or request a restart/model run.
 */
(async () => {
  const origin = "https://multi-7009.agents.nousresearch.com";
  const profile = "paperwork-review";
  const url = `${origin}/api/env?profile=${profile}`;
  let stage = "origin";
  try {
    if (location.origin !== origin) {
      console.log({ profile, outcome: "refused", reason: "Open Multi's Hermes dashboard first." });
      return;
    }
    stage = "read";
    const before = await fetch(url, {
      credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000)
    });
    if (!before.ok) {
      console.log({ profile, outcome: "refused", stage, status: before.status });
      return;
    }
    const info = await before.json();
    if (info.API_SERVER_KEY?.is_set !== false) {
      console.log({ profile, outcome: "unchanged", reason: "Key already exists or its state is unknown." });
      return;
    }
    const key = prompt("Paste the generated 64-character hex key for paperwork-review only:")?.trim();
    if (!key) {
      console.log({ profile, outcome: "cancelled" });
      return;
    }
    if (!/^[a-f0-9]{64}$/i.test(key)) {
      console.log({ profile, outcome: "refused", reason: "Expected the 64-character hex key generated with openssl." });
      return;
    }
    // Rechecking narrows the prompt window; it cannot make this an atomic create-only write.
    stage = "recheck";
    const current = await fetch(url, {
      credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000)
    });
    if (!current.ok) {
      console.log({ profile, outcome: "refused", stage, status: current.status });
      return;
    }
    const currentInfo = await current.json();
    if (currentInfo?.API_SERVER_KEY?.is_set !== false) {
      console.log({ profile, outcome: "refused", stage, reason: "Key exists or its state is unknown; no write was sent." });
      return;
    }
    stage = "save";
    const response = await fetch(url, {
      method: "PUT", credentials: "same-origin", redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, key: "API_SERVER_KEY", value: key })
    });
    const saved = response.ok && (await response.json()).ok === true;
    console.log({ profile, status: response.status, outcome: saved ? "saved" : "unverified" });
  } catch {
    console.log({ profile, outcome: stage === "save" ? "unverified" : "refused", stage,
      reason: "Request failed; no automatic retry. Check the key's is_set flag before trying again." });
  }
})();
