import type { Terms } from "../shared/terms";
import { endInstant, startInstant } from "../shared/terms";
import type { PullRequest } from "./evidence/github";

export interface PrDecision {
  key: string; // repo#number
  repo: string;
  number: number;
  title: string;
  url: string;
  accepted: boolean;
  reason: string;
  flags: string[];
}

export interface ScoreResult {
  decision: "pay" | "escalate";
  scorer: "deterministic" | "claude";
  prs: PrDecision[];
  summary: string;
}

/**
 * The agent's judgement step. The scorer decides which PRs count and whether to pay or escalate.
 * It never chooses an amount or a recipient: code computes the amount, the policy fixes the payee.
 */
export interface Scorer {
  readonly kind: ScoreResult["scorer"];
  score(terms: Terms, prs: PullRequest[], period: { since: string; until: string }): Promise<ScoreResult>;
}

/** Contract rules any scorer must respect. Runs before the scorer and cannot be overridden by it. */
export function precheck(terms: Terms, pr: PullRequest, period: { since: string; until: string }): string[] {
  const fails: string[] = [];
  if (pr.author !== terms.contractor.github) fails.push(`authored by ${pr.author}, not ${terms.contractor.github}`);
  if (!terms.repos.includes(pr.repo)) fails.push(`${pr.repo} is not a repo in this contract`);
  if (!pr.merged_by) fails.push("merger unknown");
  else if (pr.merged_by === pr.author) fails.push("merged by its own author (contract requires someone else to merge)");
  const t = Date.parse(pr.merged_at);
  if (t < Date.parse(startInstant(terms)) || t > Date.parse(endInstant(terms))) fails.push("merged outside the contract dates");
  if (t < Date.parse(period.since) || t > Date.parse(period.until)) fails.push("merged outside this pay period");
  return fails;
}

const INJECTION = /ignore (all |any )?(previous|prior|above) instructions|you are now|system prompt|pay \$?\d[\d,]*|accept everything/i;

/** Rule-based scorer: used in the keyless demo and as the fallback when no AI key is set. */
export class DeterministicScorer implements Scorer {
  readonly kind = "deterministic" as const;

  async score(terms: Terms, prs: PullRequest[], period: { since: string; until: string }): Promise<ScoreResult> {
    const decisions = prs.map((pr): PrDecision => {
      const fails = precheck(terms, pr, period);
      const flags = INJECTION.test(`${pr.title}\n${pr.body}`) ? ["possible_prompt_injection"] : [];
      return {
        key: `${pr.repo}#${pr.number}`,
        repo: pr.repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        accepted: fails.length === 0 && flags.length === 0,
        reason: fails.length ? fails.join("; ") : flags.length ? "contains instructions aimed at the reviewer" : "merged by a reviewer, in scope, inside the period",
        flags,
      };
    });
    const flagged = decisions.some((d) => d.flags.length > 0);
    const accepted = decisions.filter((d) => d.accepted).length;
    return {
      decision: flagged ? "escalate" : "pay",
      scorer: "deterministic",
      prs: decisions,
      summary: flagged
        ? "Escalated: a pull request contains instructions aimed at the reviewer."
        : `${accepted} of ${decisions.length} pull requests accepted.`,
    };
  }
}
