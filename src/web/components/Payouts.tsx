import { useState } from "react";
import { USDC_NEAR } from "../../shared/terms";
import { api, prepareVote, submitVote, termsMatch } from "../api";
import type { AppConfig, AttemptState, ContractView, PayoutView, VoteAnswer } from "../types";
import { Icon, type IconName } from "./icons";
import { SignBox } from "./SignBox";
import { Alert, Badge, Button, Card, CardHeader, Empty, Mono, short, timeText, type Tone, usd } from "./ui";

export const NO_CLAUSE = "The policy refused it.";

export type Act = (fn: () => Promise<unknown>) => Promise<void>;

export const ATTEMPT: Record<AttemptState, { label: string; tone: Tone }> = {
  pending: { label: "Sending", tone: "info" },
  blocked: { label: "Blocked", tone: "danger" },
  waiting: { label: "Waiting", tone: "info" },
  unknown: { label: "Outcome unknown", tone: "warning" },
  refused: { label: "Refused", tone: "danger" },
  held: { label: "Needs your approval", tone: "warning" },
  processing: { label: "Settling", tone: "info" },
  paid: { label: "Paid", tone: "success" },
  rejected: { label: "Rejected", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
  resolved: { label: "Resolved", tone: "neutral" },
  dropped: { label: "Dropped", tone: "neutral" },
};

const RESOLUTION = { arrived: "Marked as arrived", reowe: "Owed again", rejected: "Counted as rejected" } as const;

export function PayoutsTab({ c, config, act }: { c: ContractView; config: AppConfig; act: Act }) {
  const list = c.payouts.filter((p) => p.kind === "payout");
  const oj = c.open_judgment;
  const latest = list[0];
  const canRetry = oj?.outcome === "pending" && latest?.state === "refused";
  return (
    <Card pad={false}>
      <div className="card-pad-x">
        <CardHeader
          title="Payouts"
          sub={`Every payout waits for ${c.terms.representative.near_account}'s approval · ${usd(c.paid_usd)} of ${usd(c.total_usd)} paid`}
          actions={
            <Button icon="play" disabled={c.stage !== "active"} onClick={() => act(() => api("POST", `/contracts/${c.id}/run`))}>
              Check merges
            </Button>
          }
        />
      </div>
      {oj && oj.outcome === "pending" ? (
        <div className="judgment-bar">
          <Icon name="bot" size={15} />
          <span>
            Open judgment: {usd(oj.paid_usd)} paid{Number(oj.owed_usd) > 0 ? `, ${usd(oj.owed_usd)} still to request` : ""}. New merges wait until it closes.
          </span>
          {canRetry ? (
            <>
              <Button size="sm" icon="play" onClick={() => act(() => api("POST", `/contracts/${c.id}/retry`))}>
                Retry
              </Button>
              <Button size="sm" variant="secondary" onClick={() => act(() => api("POST", `/contracts/${c.id}/drop`))}>
                Drop
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {list.length === 0 ? (
        <Empty icon="bot" title="No payouts yet" sub="When a merged PR completes part of the scope, Covenant requests that part and the platform holds it for your approval." />
      ) : (
        <ul className="payouts">
          {list.map((p) => (
            <PayoutItem key={p.request_id} p={p} c={c} config={config} act={act} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function PayoutItem({ p, c, config, act }: { p: PayoutView; c: ContractView; config: AppConfig; act: Act }) {
  const [open, setOpen] = useState(false);
  const st = ATTEMPT[p.state];
  return (
    <li className="payout">
      <button className="payout-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="payout-amount num">{usd(p.amount_usd)}</span>
        <span className="payout-meta">
          {p.lines.map((l) => (
            <span key={l.deliverable_id} className="payout-d">
              <span className="scope-id">{l.deliverable_id}</span> {l.title}
            </span>
          ))}
          <span className="pill-mini">
            payout {p.seq} · attempt {p.attempt}
          </span>
          <span className="muted small hide-sm">{timeText(p.created_at)}</span>
        </span>
        <Badge tone={st.tone} dot>
          {p.state === "resolved" && p.resolution ? RESOLUTION[p.resolution] : st.label}
        </Badge>
        <Icon name="chevronRight" className={`chev-rot${open ? " is-open" : ""}`} />
      </button>

      {p.state === "held" ? <ApprovalCard p={p} config={config} act={act} /> : <StateNote p={p} act={act} />}

      {open ? <PayoutDetail p={p} /> : null}
    </li>
  );
}

export function PayoutDetail({ p }: { p: PayoutView }) {
  return (
    <div className="payout-detail">
      {p.prs.length ? (
        <ul className="prs">
          {p.prs.map((pr) => (
            <li key={pr.key} className={pr.flags.length ? "warn" : "ok"}>
              <Icon name={pr.flags.length ? "alert" : "check"} size={14} />
              <a href={pr.url} target="_blank" rel="noreferrer" className="pr-key">
                {pr.key}
              </a>
              <span className="pr-title">{pr.title}</span>
              {pr.flags.length ? <span className="pr-reason">{pr.flags.join(" · ")}</span> : null}
            </li>
          ))}
          {p.judge ? (
            <li className="no">
              <Icon name="bot" size={14} />
              <span className="pr-key">{p.judge.model ?? (p.judge.kind === "near-ai" ? "NEAR AI" : "rules")}</span>
              <span className="pr-title">{p.judge.summary}</span>
            </li>
          ) : null}
        </ul>
      ) : null}
      <div className="kv-line">
        <span>Request id</span>
        <Mono copy={p.request_id}>{p.request_id}</Mono>
      </div>
      {p.tx_hash ? (
        <div className="kv-line">
          <span>Transaction</span>
          <Mono copy={p.tx_hash}>{short(p.tx_hash, 14, 6)}</Mono>
        </div>
      ) : null}
      {p.refund_tx_hash ? (
        <div className="kv-line">
          <span>Refund</span>
          <Mono copy={p.refund_tx_hash}>{short(p.refund_tx_hash, 14, 6)}</Mono>
        </div>
      ) : null}
      {p.code || p.failure_code ? (
        <div className="kv-line">
          <span>Platform code</span>
          <code>{p.code ?? p.failure_code}</code>
        </div>
      ) : null}
    </div>
  );
}

/** What happened to an attempt that isn't waiting for approval, and what the representative can do. */
export function StateNote({ p, act }: { p: PayoutView; act: Act }) {
  const clause = p.clause ? (
    <span>
      <strong>{p.clause.title}.</strong> {p.clause.text}
    </span>
  ) : null;
  const note = (tone: Tone, icon: IconName, title: string, body?: React.ReactNode, actions?: React.ReactNode) => (
    <div className={`state-note tone-${tone}`}>
      <Icon name={icon} size={15} />
      <div className="state-text">
        <strong>{title}</strong>
        {body}
      </div>
      {actions ? <div className="state-actions">{actions}</div> : null}
    </div>
  );
  switch (p.state) {
    case "pending":
      return note("info", "send", "Sending to the platform.");
    case "processing":
      return note("info", "clock", "Approved. Settling on NEAR.", <span>Public withdrawal to {p.recipient}; it may arrive less a route fee.</span>);
    case "waiting":
      return note("info", "clock", "The platform asked Covenant to wait.", <span>Covenant asks again with the same request id{p.code ? ` (${p.code})` : ""}.</span>);
    case "unknown":
      return note("warning", "alert", "No answer from the platform yet.", <span>Covenant reads the payout's status before asking again, and never under a new id, so it can't pay twice.</span>);
    case "blocked":
      return note("danger", "ban", "Blocked before anything was sent.", clause ?? <span>Code {p.code ?? "unknown"}. Covenant re-asks the same request id once it's fixed.</span>);
    case "refused":
      return note("danger", "shieldCheck", "Refused by the platform. Nothing was sent.", clause ?? <span>{NO_CLAUSE}</span>);
    case "dropped":
      return note("neutral", "x", "You dropped it while it was blocked. The platform never recorded it, so nothing was sent.", null);
    case "rejected":
      return note("neutral", "x", p.kind === "attack" ? "Rejected. Nothing moved." : "You rejected it. Nothing moved.", p.kind === "payout" ? <span>Its PRs stay out of later runs.</span> : null);
    case "failed":
      if (p.resolution) return null;
      return note(
        "danger",
        "alert",
        "The platform reports this payout failed.",
        <span>
          {p.failure_code ? `Code ${p.failure_code}. ` : ""}
          {p.tx_hash ? "A transaction exists, so check whether it arrived. " : "No transaction was found. "}
          The amount stays committed until you decide.
        </span>,
        <>
          <Button size="sm" variant="secondary" onClick={() => act(() => api("POST", `/payouts/${p.request_id}/resolve`, { outcome: "arrived" }))}>
            It arrived
          </Button>
          <Button size="sm" onClick={() => act(() => api("POST", `/payouts/${p.request_id}/resolve`, { outcome: "reowe" }))}>
            Owe it again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => act(() => api("POST", `/payouts/${p.request_id}/resolve`, { outcome: "rejected" }))}>
            Count as rejected
          </Button>
        </>,
      );
    default:
      return null;
  }
}

/**
 * The held payout, as the representative decides it. Leads with the judge's flags, then the terms the
 * platform will release: payee, USDC, amount, a public withdrawal on NEAR.
 */
export function ApprovalCard({ p, config, act, attack = false }: { p: PayoutView; config: AppConfig; act: Act; attack?: boolean }) {
  const [vote, setVote] = useState<VoteAnswer | null>(null);
  const [verdict, setVerdict] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flags = p.prs.flatMap((pr) => pr.flags.map((f) => ({ pr: pr.key, f })));
  const voted = p.vote !== null;

  const decide = async (v: "approve" | "reject") => {
    setError(null);
    let answer: VoteAnswer;
    try {
      answer = await prepareVote(p.request_id, v);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (v === "approve" && !termsMatch(p, answer.terms, USDC_NEAR)) {
      setError("The platform's terms for this approval don't match the payout. Not signing.");
      return;
    }
    setVerdict(v);
    setVote(answer);
    if (config.demo_controls) await act(() => submitVote(config, answer));
  };

  return (
    <div className={`approval${attack ? " is-attack" : ""}`}>
      <div className="approval-head">
        <Icon name="shield" size={15} />
        <strong>{attack ? "NOT STOPPED by policy: the approval is the second layer" : "Held for your approval"}</strong>
        {p.approval?.expires_at ? <span className="muted small">Approval expires {timeText(p.approval.expires_at)}</span> : null}
      </div>
      <div className={`approval-flags${flags.length ? "" : " is-clear"}`}>
        {flags.length ? (
          <>
            <strong>
              <Icon name="alert" size={14} /> The judge flagged {flags.length === 1 ? "this" : `${flags.length} things`}
            </strong>
            <ul>
              {flags.map((x) => (
                <li key={x.pr + x.f}>
                  {x.pr}: {x.f}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <span>The judge flagged nothing.</span>
        )}
        {p.judge ? <span>{p.judge.summary}</span> : null}
      </div>
      <div className="approval-terms">
        <div>
          <span>Pays</span>
          <strong>{p.recipient}</strong>
        </div>
        <div>
          <span>Asset</span>
          <strong>USDC</strong>
        </div>
        <div>
          <span>Amount</span>
          <strong>{usd(p.amount_usd)}</strong>
        </div>
        {p.lines.length ? (
          <div>
            <span>For</span>
            <strong>{p.lines.map((l) => l.deliverable_id).join(", ")}</strong>
          </div>
        ) : null}
      </div>
      <div className="approval-foot">
        <span>Public withdrawal on NEAR; it may arrive less a route fee.</span>
        {voted ? (
          <Badge tone="info">Vote sent: {p.vote}</Badge>
        ) : (
          <>
            {attack ? null : (
              <Button size="sm" icon="check" onClick={() => decide("approve")}>
                Approve {usd(p.amount_usd)}
              </Button>
            )}
            <Button size="sm" variant={attack ? "danger" : "secondary"} icon="x" onClick={() => decide("reject")}>
              Reject
            </Button>
          </>
        )}
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {vote && !config.demo_controls ? (
        <div className="approval-foot">
          {vote.sign ? (
            <SignBox config={config} req={vote.sign} label={verdict === "approve" ? "Sign approval" : "Sign rejection"} onSign={() => act(() => submitVote(config, vote))} />
          ) : vote.confirm ? (
            <a className="btn btn-primary btn-sm" href={vote.confirm.url} target="_blank" rel="noreferrer">
              <Icon name="external" /> <span>Open the platform's confirm page</span>
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
