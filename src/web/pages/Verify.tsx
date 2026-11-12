import { useCallback, useEffect, useState } from "react";
import type { PublicVerificationView } from "../../shared/views";
import { api } from "../api";
import { Alert, Button, Mono, PageLoading, timeText } from "../components/ui";

const checkLabels: Record<string, string> = {
  terms: "Terms match their hash", "sig-representative": "Agency signature", "sig-contractor": "Builder signature",
  platform: "Platform setup", applied: "Policy in force", actions: "Allowed actions", assets: "Allowed asset",
  payee: "Agreed payee", cap: "Per-payment limit", approval: "Owner approval required", frozen: "Agent available",
  grant: "Live payout grant", consent: "Payout consent", signed: "Policy matches signed terms",
};

/** Public app-relayed checks. Private job details are fetched only on the authenticated job page. */
export function VerifyPage({ id }: { id: string }) {
  const [view, setView] = useState<PublicVerificationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const load = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    setView(null);
    setError(null);
    void api<PublicVerificationView>("GET", `/contracts/${id}/verify/public`).then((result) => {
      if (active) setView(result);
    }).catch((cause: Error) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [id, generation]);
  if (error) return <div className="narrow"><Alert tone="danger">{error}</Alert><Button onClick={load}>Re-check</Button></div>;
  if (!view) return <PageLoading />;
  return <div className="narrow">
    <div className="card card-pad">
      <h1>Verification status</h1>
      <p>{view.overall === "green" ? "Checks passed" : view.overall === "red" ? "Some checks failed" : "Checks incomplete"}</p>
      <p>Workflow version {view.workflow_version} · Checked {timeText(view.checked_at)}</p>
      <p>Terms hash</p><Mono copy={view.terms_hash}>{view.terms_hash}</Mono>
      <ul className="checks">{Object.entries(view.checks).map(([key, ok]) => <li key={key} className={ok ? "ok" : "bad"}>{checkLabels[key] ?? "Check"}: {ok ? "passed" : "not passed"}</li>)}</ul>
      <p className="fineprint">Paperwork relays these checks. This is not independent cryptographic proof or confirmation of payment. Job details require a named party’s sign-in. Funding alone does not enforce a lifetime job cap.</p>
      <Button onClick={load}>Re-check</Button>
    </div>
  </div>;
}
