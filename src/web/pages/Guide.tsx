import { STEPS } from "../guide";

export function GuidePage() {
  return (
    <div className="container prose">
      <p className="eyebrow">Guide</p>
      <h1>How Covenant works</h1>
      <p className="lede">
        A contract and a wallet are usually two things: a PDF that says what should happen, and a hot wallet that can do anything. Covenant makes them
        one thing. Every signed work order gets its own NEAR Intents agent wallet, and the contract's terms become that wallet's spending policy.
      </p>

      <h2>Who does what</h2>
      <ul>
        <li>
          <strong>Representative</strong>: drafts the work order, signs it, owns the contract wallet, funds it, can cancel a payout during its timelock
          or freeze the wallet.
        </li>
        <li>
          <strong>Contractor</strong>: signs the same terms and can verify the live wallet at any time.
        </li>
        <li>
          <strong>Agent</strong>: Covenant's server. It reviews merged pull requests, decides what to pay, and sends payouts with a revocable grant.
          It never holds an owner key.
        </li>
        <li>
          <strong>NEAR Intents</strong>: holds the funds and refuses anything the policy doesn't allow.
        </li>
      </ul>

      <h2>What NEAR enforces, and what Covenant checks</h2>
      <table className="prs">
        <thead>
          <tr>
            <th>Clause</th>
            <th>Enforced by</th>
            <th>How</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Payee</td>
            <td>NEAR Intents</td>
            <td>Policy destinations: only the payee</td>
          </tr>
          <tr>
            <td>Monthly cap</td>
            <td>NEAR Intents</td>
            <td>Per-payment and monthly limits = cap; USD budget backstop</td>
          </tr>
          <tr>
            <td>End date</td>
            <td>NEAR Intents</td>
            <td>The agent's grant expires at the end date</td>
          </tr>
          <tr>
            <td>Cancel window</td>
            <td>NEAR Intents</td>
            <td>Policy timelock; the owner can cancel queued payouts</td>
          </tr>
          <tr>
            <td>Rate, scope, acceptance, start date</td>
            <td>Covenant</td>
            <td>Checked before sending; the provider still caps the result</td>
          </tr>
        </tbody>
      </table>

      <h2>The steps</h2>
      {STEPS.map((s) => (
        <section key={s.id} className="guide-step" id={s.id}>
          <h3>
            {s.n}. {s.title} <span className="muted">· {s.who}</span>
          </h3>
          <p>{s.short}</p>
          <ul>
            {s.what.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <p className="enforced-line">
            <strong>Enforced:</strong> {s.enforced.join(" ")}
          </p>
        </section>
      ))}

      <h2>Run it yourself</h2>
      <pre className="message">{`bun install
bun run demo:e2e   # the whole flow, headless, no keys, no network
bun run demo       # the same thing in this browser UI
bun test`}</pre>
      <p>
        <a className="btn btn-primary" href="#/new">
          Start the wizard
        </a>
      </p>
    </div>
  );
}
