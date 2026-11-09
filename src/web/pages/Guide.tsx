import { Icon, type IconName } from "../components/icons";
import { LinkButton } from "../components/ui";

const FLOW: { icon: IconName; title: string; text: string }[] = [
  { icon: "file", title: "Scope", text: "Deliverables, each with a value" },
  { icon: "pen", title: "Sign", text: "Both parties, NEP-413" },
  { icon: "wallet", title: "Set up", text: "One platform agent per contract" },
  { icon: "bot", title: "Judge and approve", text: "Judge sizes it, you approve it" },
  { icon: "shieldCheck", title: "Verify", text: "Anyone, any time" },
];

const ENFORCED: [string, string, boolean][] = [
  ["Payee", "The agent can only withdraw to the payee", true],
  ["Largest deliverable", "No single payment above it", true],
  ["Your approval", "The platform holds every payout until you vote", true],
  ["Scope total", "The agent is funded with exactly the total", true],
  ["End date", "Covenant's payout consent ends with the contract", true],
  ["How complete each deliverable is", "Judged on every merge (NEAR AI Cloud or rules)", false],
  ["Acceptance, repos, start date", "Checked before judging", false],
];

export function GuidePage() {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>How it works</h1>
          <p className="page-sub">A signed scope, paid through a platform agent made for it.</p>
        </div>
        <LinkButton href="#/new" variant="primary" icon="plus">
          New contract
        </LinkButton>
      </header>

      <div className="flow">
        {FLOW.map((s, i) => (
          <div className="flow-step" key={s.title}>
            <span className="icon-tile lg">
              <Icon name={s.icon} size={20} />
            </span>
            <div className="flow-n">{i + 1}</div>
            <h3>{s.title}</h3>
            <p>{s.text}</p>
          </div>
        ))}
      </div>

      <div className="split even">
        <section className="card card-pad">
          <h2 className="h2">Who enforces what</h2>
          <ul className="enforce">
            {ENFORCED.map(([k, v, near]) => (
              <li key={k}>
                <Icon name={near ? "lock" : "check"} size={15} />
                <div>
                  <strong>{k}</strong>
                  <span>{v}</span>
                </div>
                <span className={`who-tag ${near ? "near" : "app"}`}>{near ? "Platform" : "Covenant"}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card card-pad">
          <h2 className="h2">Roles</h2>
          <ul className="enforce">
            {(
              [
                ["building", "Representative", "Signs, owns and funds the agent. Approves or rejects every payout."],
                ["user", "Contractor", "Signs the same terms. Verifies the live policy."],
                ["bot", "Covenant", "Judges merged PRs and requests payouts with its app credential. Never holds the owner key."],
                ["shield", "MultiAgency platform", "Holds the policy and funds. Refuses anything outside it; holds the rest for approval."],
              ] as const
            ).map(([icon, k, v]) => (
              <li key={k}>
                <Icon name={icon} size={15} />
                <div>
                  <strong>{k}</strong>
                  <span>{v}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card card-pad">
        <h2 className="h2">Run it locally</h2>
        <pre className="code">{`bun install
bun run demo:e2e   # whole flow on the platform stand-in: no keys, no network
bun run demo       # this UI, on the stand-in
bun run demo:stack # against the local MultiAgency platform stack
bun test`}</pre>
      </section>
    </div>
  );
}
