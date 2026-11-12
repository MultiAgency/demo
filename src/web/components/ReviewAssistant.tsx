import type { AbstractAgent } from "@ag-ui/client";
import { CopilotKitCore } from "@copilotkit/core";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { JobSubmissionView } from "../../shared/jobs";
import { reviewResultSchema, type ReviewResult } from "../../shared/review";
import type { ContractView } from "../types";
import { Alert, Badge, Button, Spinner, type Tone } from "./ui";
import "../review-assistant.css";

interface ReviewAssistantProps {
  c: ContractView;
  s: JobSubmissionView;
  enabled: boolean;
  existingFeedback: string;
  onApply: (feedback: string) => void;
  disabled?: boolean;
}

const FINDING_STATUS: Record<ReviewResult["findings"][number]["status"], { label: string; tone: Tone }> = {
  supported: { label: "Described in submission", tone: "info" },
  needs_clarification: { label: "Needs clarification", tone: "warning" },
  missing_evidence: { label: "Missing evidence", tone: "warning" },
};

/** Applying this draft only updates the existing editable feedback field. */
export function ReviewAssistant(props: ReviewAssistantProps) {
  const [opened, setOpened] = useState(false);
  const headingId = useId();
  return <section className="review-assistant" aria-labelledby={headingId}>
    <div className="review-assistant-heading">
      <div>
        <h3 id={headingId}>Review assistant</h3>
        <p className="small muted">Compare the report with the signed criteria and prepare feedback you can edit.</p>
      </div>
      {!opened && props.enabled ? <Button variant="secondary" icon="bot" disabled={props.disabled} onClick={() => setOpened(true)}>Prepare review</Button> : null}
    </div>
    {!props.enabled ? <p className="small muted" style={{ marginTop: 10 }}>Review assistance is unavailable. You can inspect the evidence and write feedback below.</p> : opened ? <ReviewRun {...props} /> : null}
  </section>;
}

function ReviewRun({ c, s, existingFeedback, onApply, disabled }: ReviewAssistantProps) {
  const [connection, setConnection] = useState<{ copilotkit: CopilotKitCore; agent: AbstractAgent } | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const agent = connection?.agent;
  const copilotkit = connection?.copilotkit;
  const isReady = connection !== null;
  const [busy, setBusy] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [progress, setProgress] = useState("Connecting review assistant…");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [draft, setDraft] = useState("");
  const [applied, setApplied] = useState(false);
  const mounted = useRef(true);
  const cancelled = useRef(false);
  const started = useRef(false);
  const generation = useRef(0);
  const draftId = useId();

  useEffect(() => {
    mounted.current = true;
    let active = true;
    started.current = false;
    setConnection(null);
    setError(null);
    setProgress("Connecting review assistant…");
    const client = new CopilotKitCore({
      runtimeUrl: `/api/submissions/${encodeURIComponent(s.id)}/review/copilotkit`,
      credentials: "same-origin",
      deferInitialConnection: true,
    });
    const subscription = client.subscribe({
      onAgentsChanged: ({ agents }) => {
        if (!active) return;
        if (agents.review) setConnection({ copilotkit: client, agent: agents.review });
      },
      onRuntimeConnectionStatusChanged: ({ status }) => {
        if (!active || status !== "connected" || client.getAgent("review")) return;
        setError("Review assistance is unavailable. Try reconnecting or write feedback below.");
        setProgress("Review assistance is unavailable.");
      },
      onError: ({ code }) => {
        if (!active || (code !== "runtime_info_fetch_failed" && code !== "agent_not_found")) return;
        setError("Review assistance could not connect. Try reconnecting or write feedback below.");
        setProgress("The review connection failed.");
      },
    });
    client.connect();
    return () => {
      active = false;
      mounted.current = false;
      generation.current++;
      subscription.unsubscribe();
      const runningAgent = client.getAgent("review");
      if (runningAgent) client.stopAgent({ agent: runningAgent });
      client.setRuntimeUrl(undefined);
    };
  }, [s.id, connectionAttempt]);

  useEffect(() => {
    if (!agent) return;
    const { unsubscribe } = agent.subscribe({
      onRunStartedEvent: () => {
        if (mounted.current && !cancelled.current) setAgentRunning(true);
      },
      onRunFinalized: () => {
        if (mounted.current) setAgentRunning(false);
      },
      onStateChanged: ({ state }) => {
        if (!mounted.current || cancelled.current) return;
        if (typeof state.progress === "string") setProgress(state.progress);
        if (state.result) {
          const parsed = reviewResultSchema.safeParse(state.result);
          if (!parsed.success) {
            setError("The review draft could not be read. Try again or write feedback below.");
            return;
          }
          const review = parsed.data;
          setResult(review);
          setDraft(review.feedback);
          setApplied(false);
          setProgress("Review ready. Check the observations and edit the feedback.");
        }
      },
      onRunErrorEvent: ({ event }) => {
        if (!mounted.current || cancelled.current) return;
        setError(event.message || "The review could not be prepared. Try again or write feedback below.");
      },
      onRunFailed: () => {
        if (!mounted.current || cancelled.current) return;
        setError((currentError) => currentError ?? "The review connection was interrupted. Try again or write feedback below.");
      },
    });
    return unsubscribe;
  }, [agent]);

  const run = useCallback(async () => {
    if (!agent || !copilotkit || agent.isRunning || disabled) return;
    const current = ++generation.current;
    cancelled.current = false;
    setBusy(true);
    setError(null);
    setResult(null);
    setDraft("");
    setApplied(false);
    setProgress("Preparing the signed criteria and submitted report…");
    agent.setState({});
    agent.setMessages([{ id: crypto.randomUUID(), role: "user", content: "Prepare a review of this report against the signed acceptance criteria." }]);
    try {
      await copilotkit.runAgent({ agent, forwardedProps: { terms_hash: s.terms_hash, revision: s.revision, state: s.state, judgment_id: s.judgment_id } });
      if (mounted.current && current === generation.current && !cancelled.current && !agent.state.result) {
        setError((currentError) => currentError ?? "The review ended without a complete draft. Try again or write feedback below.");
      }
    } catch {
      if (mounted.current && current === generation.current && !cancelled.current) setError((currentError) => currentError ?? "The review could not be prepared. Try again or write feedback below.");
    } finally {
      if (mounted.current && current === generation.current) setBusy(false);
    }
  }, [agent, copilotkit, disabled, s.terms_hash, s.revision, s.state, s.judgment_id]);

  useEffect(() => {
    if (!isReady || started.current) return;
    started.current = true;
    void run();
  }, [isReady, run]);

  const cancel = () => {
    cancelled.current = true;
    generation.current++;
    if (agent && copilotkit) copilotkit.stopAgent({ agent });
    setBusy(false);
    setResult(null);
    setDraft("");
    setError(null);
    setProgress("Review cancelled. You can prepare another review or write feedback below.");
  };

  return <div className="review-assistant-body" aria-busy={busy}>
    <div className="review-assistant-actions">
      <div className="review-assistant-progress small muted" role="status" aria-live="polite">
        {busy || (!isReady && !error) ? <Spinner /> : null}<span>{progress}</span>
      </div>
      {busy ? <Button key="cancel" variant="ghost" size="sm" onClick={cancel}>Cancel review</Button> : isReady ? <Button key="run" variant="ghost" size="sm" disabled={disabled || agentRunning} onClick={run}>{error ? "Retry review" : "Prepare another review"}</Button> : error ? <Button key="reconnect" variant="secondary" size="sm" onClick={() => setConnectionAttempt((attempt) => attempt + 1)}>Reconnect review</Button> : null}
    </div>
    {error ? <Alert tone="danger">{error}</Alert> : null}
    {result ? <>
      <p className="review-assistant-summary">{result.summary}</p>
      <p className="small muted">Based on the report and submitted references. Open the evidence to check the work itself.</p>
      <ul className="review-assistant-findings">
        {result.findings.map((finding) => {
          const deliverable = c.terms.scope.find((d) => d.id === finding.deliverable_id);
          const status = FINDING_STATUS[finding.status];
          return <li key={finding.deliverable_id} className="review-assistant-finding">
            <header><h4>{deliverable?.title ?? finding.deliverable_id}</h4><Badge tone={status.tone}>{status.label}</Badge></header>
            {deliverable ? <p className="review-assistant-criteria">Signed criteria: {deliverable.criteria}</p> : null}
            <p>{finding.comment}</p>
            {finding.report_quotes.map((quote, i) => <p className="small" key={i}>From the report: “{quote}”</p>)}
            {finding.evidence_indices.length ? <ul className="review-assistant-sources" aria-label={`Submitted references for ${deliverable?.title ?? finding.deliverable_id}`}>
              {finding.evidence_indices.map((index) => {
                const evidence = s.evidence[index];
                return evidence ? <li key={index}><a href={evidence.url} target="_blank" rel="noreferrer">{evidence.label}</a></li> : null;
              })}
            </ul> : null}
          </li>;
        })}
      </ul>
      <div className="review-assistant-draft">
        <label className="field" htmlFor={draftId}><span className="field-label">Draft feedback</span><textarea id={draftId} rows={5} maxLength={2000} value={draft} onChange={(e) => { setDraft(e.target.value); setApplied(false); }} /></label>
        <div className="review-assistant-actions">
          <Button variant="secondary" disabled={disabled || busy || draft.trim().length < 3} onClick={() => { onApply(draft.trim()); setApplied(true); }}>{existingFeedback.trim() && existingFeedback !== draft.trim() ? "Replace feedback with draft" : "Use draft in feedback"}</Button>
          <p className="small muted" role="status">{applied ? "Added to Changes needed below. Review it before requesting changes." : "You can edit this draft before adding it to Changes needed."}</p>
        </div>
      </div>
    </> : null}
  </div>;
}
