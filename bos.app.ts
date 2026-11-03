import { App } from "everything-dev/descriptor";

// everything.dev identity for Covenant. Covenant runs as its own Bun app (it is not split into
// everything.dev's ui/ api/ plugins/ slots); sign-in uses the same stack as everything.dev apps:
// Better-Auth + better-near-auth (Sign in with NEAR, NEP-413), see src/server/auth.ts.
// Not type-checked with the app (everything-dev is not a dependency); used by the `bos` CLI.
export default App({
  name: "covenant",
  extends: "bos://dev.everything.near/dev.everything.dev",
  account: "multiagentic.near",
  title: "Covenant",
  description: "Contractor payroll on NEAR: every signed contract becomes its own NEAR Intents agent wallet.",
  repository: "https://github.com/MultiAgency/demo",
});
