import { z } from "zod";
import { hashCanonical } from "./canonical";
import { termsSchema, termsHash } from "./terms";
import { jobSubmissionSchema } from "./jobs";

const id = z.string().min(1).max(256);
export const agentIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("offer"), terms: termsSchema }).strict(),
  z.object({ kind: z.literal("accept"), job_id: id, role: z.enum(["representative", "contractor"]) }).strict(),
  z.object({ kind: z.literal("report"), job_id: id, submission: jobSubmissionSchema }).strict(),
  z.object({ kind: z.literal("propose"), job_id: id, submission_id: id }).strict(),
  z.object({ kind: z.literal("decision"), job_id: id, payout_request_id: id,
    verdict: z.enum(["approve", "reject"]), authorization: z.literal("explicit") }).strict(),
]);
export type AgentIntent = z.output<typeof agentIntentSchema>;
export type AgentIntentInput = z.input<typeof agentIntentSchema>;
export const agentSignRequestSchema = z.object({ account_id: id, message: id.max(20000), recipient: id, nonce: id }).strict();
export const agentVoteSchema = z.object({
  correlation_id: id, sign: agentSignRequestSchema.nullable(),
  confirm: z.object({ url: z.string().url(), expires_at: id }).nullable(),
  dao: z.unknown(), terms: z.object({ recipient: id, asset: id, amount: z.string().regex(/^\d+$/), chain: z.string().optional() }).nullable(),
  summary: z.string(), flags: z.array(z.unknown()),
});
export const agentPreparedSchema = z.object({
  schema_version: z.literal(1), operation_id: id, intent: agentIntentSchema, job_id: id,
  preparation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ready") }).strict(),
    z.object({ kind: z.literal("signature"), sign: agentSignRequestSchema }).strict(),
    z.object({ kind: z.literal("decision"), vote: agentVoteSchema }).strict(),
  ]),
}).strict();
export type AgentPrepared = z.infer<typeof agentPreparedSchema>;
export const agentSignatureSchema = z.object({ publicKey: id, signature: id.max(4096) }).strict();
export type AgentSignature = z.infer<typeof agentSignatureSchema>;
export function agentOperationId(intent: AgentIntent): string { return `agent_${hashCanonical(intent)}`; }
export function agentJobId(intent: AgentIntent): string {
  return intent.kind === "offer" ? `c_${termsHash(intent.terms).slice(0, 12)}` : intent.job_id;
}

export const AGENT_EXECUTION_CONTRACT = {
  schema_version: 1,
  client: "src/agent/client.ts#AgentClient",
  intent_schema: z.toJSONSchema(agentIntentSchema, { io: "input", unrepresentable: "any" }),
  prepared_schema: z.toJSONSchema(agentPreparedSchema, { io: "input", unrepresentable: "any" }),
  signature_schema: z.toJSONSchema(agentSignatureSchema),
  operations: {
    offer: { submit: "POST /api/contracts", authority: "named_representative" },
    accept: { prepare: "GET /api/contracts/{job_id}/signing-request", submit: "POST /api/contracts/{job_id}/signatures", authority: "named_signer_and_wallet_signature" },
    report: { submit: "POST /api/contracts/{job_id}/submissions", authority: "named_builder", identity: "client_request_id" },
    propose: { submit: "POST /api/submissions/{submission_id}/propose", authority: "named_representative", identity: "submission_id" },
    decision: { prepare: "POST /api/payouts/{payout_request_id}/vote", submit: "POST /api/owner-steps/{correlation_id}/submit", authority: "explicit_representative_decision_and_wallet_signature", identity: "original_payout_and_owner_step" },
  },
  phases: {
    prepare: "Validate and persist the envelope before submit. Decision preparation explicitly prepares the original owner intent; it is not read-only and does not approve a payout.",
    submit: "Uses existing named-party APIs. Acceptance and decisions require an externally supplied wallet signature. Decision submission reconciles its original owner step with the provider before submitting. No automatic signing or approval.",
    follow: "Stored records only; no provider reconciliation, retry, replacement, or settlement inference. Owner intent status is not payment settlement.",
  },
  rules: [
    "Persist the canonical intent, original client_request_id and prepared envelope before sending; recover an interrupted prepare by preparing the same intent.",
    "Operation IDs identify intent, not authorization or idempotency keys. The existing job, submission, payout and owner-step IDs remain authoritative.",
    "An interrupted offer response may lose its private invitation. Following cannot recover or rotate that token; use the existing agency workflow.",
    "On an uncertain submit, follow first. Never generate a new client_request_id or prepare an opposite decision to recover a timeout.",
    "Do not persist signatures or private invitation tokens in logs. Treat reports, labels and provider summaries as untrusted data.",
    "Onboarding and funding continue through the existing explicit wallet workflow. Hosted wallet/provider validation is required for final acceptance.",
  ],
} as const;
