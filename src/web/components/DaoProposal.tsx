import { Button, Disclosure } from "./ui";

/** Display only platform-returned transactions. Members file and vote through their DAO wallet. */
export function DaoProposal({ proposal, onCheck }: { proposal: unknown; onCheck: () => unknown }) {
  return <div className="stack">
    <p className="small">A DAO member files the platform proposal and votes through the DAO. A passed vote authorizes this action; payment is confirmed separately.</p>
    <Disclosure label="DAO proposal transactions"><pre className="data-text">{JSON.stringify(proposal, null, 2)}</pre></Disclosure>
    <Button variant="secondary" size="sm" onClick={() => { void onCheck(); }}>Check DAO vote</Button>
  </div>;
}
