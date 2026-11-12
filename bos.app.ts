import { App } from "everything-dev/descriptor";

// everything.dev identity for MultiAgency Paperwork. MultiAgency Paperwork runs as its own Bun app (it is not split into
// everything.dev's ui/ api/ plugins/ slots); sign-in uses the same stack as everything.dev apps:
// Better-Auth + better-near-auth (Sign in with NEAR, NEP-413), see src/server/auth.ts.
// Not type-checked with the app (everything-dev is not a dependency); used by the `bos` CLI.
export default App({
  // Product identity; the UI uses Paperwork and each work order is a job.
  name: "multiagency-paperwork",
  extends: "bos://dev.everything.near/dev.everything.dev",
  account: "multiagentic.near",
  title: "Paperwork",
  description: "Signed builder jobs on NEAR, with report and invoice submissions, bounded compensation and explicit agency payout approval.",
  repository: "https://github.com/MultiAgency/demo",
});
