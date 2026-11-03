import { Icon, type IconName } from "../components/icons";
import { LinkButton } from "../components/ui";

const FLOW: { icon: IconName; title: string; text: string }[] = [
  { icon: "file", title: "Scope", text: "Deliverables, each with a value" },
  { icon: "pen", title: "Sign", text: "Both parties, NEP-413" },
  { icon: "wallet", title: "Compile", text: "One funded wallet per contract" },
  { icon: "bot", title: "Pay on merge", text: "AI judges completion, NEAR limits" },
  { icon: "shieldCheck", title: "Verify", text: "Anyone, any time" },
];

const ENFORCED: [string, string, boolean][] = [
  ["Payee", "Wallet can only pay the payee", true],
  ["Scope total", "Wallet funded with the total; no payment above the largest deliverable", true],
  ["End date", "Agent's permission expires", true],
  ["Cancel window", "Timelock on every payout", true],
  ["How complete each deliverable is", "Judged on every merge (NEAR AI Cloud or rules)", false],
  ["Acceptance, repos, start date", "Checked before judging", false],
];

export function GuidePage() {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>How it works</h1>
          <p className="page-sub">A contract and a wallet, made into one thing.</p>
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
                <span className={`who-tag ${near ? "near" : "app"}`}>{near ? "NEAR Intents" : "Covenant"}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card card-pad">
          <h2 className="h2">Roles</h2>
          <ul className="enforce">
            {(
              [
                ["building", "Representative", "Signs, owns and funds the wallet. Can cancel or freeze."],
                ["user", "Contractor", "Signs the same terms. Verifies the wallet."],
                ["bot", "Agent", "Judges merged PRs against the scope and pays with a grant. Never holds the owner key."],
                ["shield", "NEAR Intents", "Holds funds. Refuses anything outside the policy."],
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
bun run demo:e2e   # whole flow, headless, no keys, no network
bun run demo       # this UI
bun test`}</pre>
      </section>
    </div>
  );
}
