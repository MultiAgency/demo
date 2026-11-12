import { Icon, type IconName } from "../components/icons";
import { LinkButton } from "../components/ui";

const FLOW: { icon: IconName; title: string; text: string }[] = [
  { icon: "file", title: "Scope", text: "Deliverables, each with a value" },
  { icon: "pen", title: "Sign", text: "Both parties, NEP-413" },
  { icon: "wallet", title: "Set up", text: "One platform agent per job" },
  { icon: "bot", title: "Submit and review", text: "Builder reports; agent proposes; agency approves or requests changes" },
  { icon: "shieldCheck", title: "Confirm payment", text: "Both parties see the platform's payment outcome" },
];

const ENFORCED: [string, string, boolean][] = [
  ["Payee", "The agent can only withdraw to the payee", true],
  ["Largest deliverable", "No single payment above it", true],
  ["Your approval", "The platform holds every payout until you vote", true],
  ["End date", "Paperwork's payout consent ends with the job", true],
  ["The whole signed policy", "Checked before every payout request; any difference and nothing is requested", false],
  ["Scope total", "You fund the agent with it; Verify shows paid + balance against it (you could deposit more)", false],
  ["Compensation proposal", "Based on report evidence and invoice, or merged PRs for Pay on merge; the agency reviews it", false],
  ["Signed scope and payment terms", "Checked before compensation is proposed", false],
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
          New job
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
                <span className={`who-tag ${near ? "near" : "app"}`}>{near ? "Platform" : "Paperwork"}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card card-pad">
          <h2 className="h2">Roles</h2>
          <ul className="enforce">
            {(
              [
                ["building", "Representative", "Signs, owns and funds the agent. Reviews the evidence and approves or rejects every payout."],
                ["user", "Builder", "Signs the terms, submits a report and invoice, and checks payment. Pay on merge uses merged PRs instead."],
                ["bot", "Paperwork", "Proposes compensation under the signed terms and requests payouts with its app credential. Never holds the owner key."],
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
        <pre className="code">{`bun install --frozen-lockfile
bun run demo:desk    # interactive offline workspace with simulated sources
bun run demo:full    # isolated SDK stack and app; simulated funds
bun run demo:browser # automated builder workflow with simulated payment
bun run demo:e2e     # legacy Pay on merge on the stand-in`}</pre>
      </section>
    </div>
  );
}
