# Product requirements

MultiAgency Paperwork gives an agency representative and builder one record of agreed work, delivery, review and payment. Desk is the single entry point, with `desk.multiagency.ai` as the target origin.

The primary users are the representative who offers and approves work and the builder who accepts, delivers and invoices. Public work seekers and wallet/DAO agencies use the adjacent openings and Agent Market workflows.

## Next milestone

**Selected 2026-11-11:** reliable local agency–builder jobs covering both Report and invoice (v3) and Pay on merge (v2), with one complete demonstration of each. Both workflows remain available for new jobs. Include verification, supported review/rework and identity-preserving recovery; unresolved payment outcomes must remain visible and block replacement payments. Signatures, provider actions and funds are simulated; hosted real-wallet acceptance is a separate milestone.

**Next priority:** payment and historical recovery first; public verification and complete browser walkthroughs follow.

**Failed-payment policy:** new and existing v2/v3 jobs require positive platform evidence of non-execution, without contradictory payment/refund evidence, before a failed payout can release budget for another payment. Runtime and startup guards enforce this rule. Unsafe historical releases block database startup; their records must be preserved and reconciled. Read-only inspection, evidence collection and an advisory preview are available; audited correction/resumption remain pending.

**Privacy policy:** full details of new and existing v2 jobs are private to the named representative/builder. Limited public verification exposes the terms hash and verification status, not identity/financial details. The [access contract](docs/recovery-acceptance.md#v2-privacy--approved) defines the projections and role boundaries. Implementation remains pending.

## Intended workflows

- **Report and invoice (v3):** offer → both parties accept → setup and funding → report, evidence and invoice → compensation proposal → agency approval → confirmed settlement.
- **Pay on merge (v2):** offer → both parties accept → setup and funding → eligible merged pull requests → compensation judgment → agency approval → confirmed settlement.

| Requirement | Expected outcome |
| --- | --- |
| R1 Agreement | Both parties sign identical terms covering scope, criteria, values, dates and payee. Signed terms and submission revisions remain immutable. |
| R2 Review | Assessment follows the signed workflow, and compensation respects scope and committed amounts. V3 also caps compensation by invoice and supports requested changes while the proposal is wholly unapproved/unpaid. The agency checks work quality. |
| R3 Payment | Each payout uses the platform's held-payout path and explicit agency approval. Failed-payment budget release follows the proof requirement above. Approval and manual arrival notes remain distinct from confirmed settlement. |
| R4 Attention | Assigned to me shows the named person's next action or waiting state. Completed requires both signatures, full signed-scope platform-confirmed payment and no unresolved commitment. |
| R5 Agency | Representatives manage their own named jobs; organization membership grants no additional private-job access. |
| R6 Discovery | Public openings retain their source and terms. Browsing or applying creates no agreement or payment obligation. |
| R7 Recovery | Saved submissions and money actions retain their original identities. An uncertain payment blocks a replacement. |
| R8 Market | Market hires and assignments retain their own wallet/DAO authorization, review and settlement rules. |

Successful acceptance demonstrates both journeys, preserves linked identities through reload and supported restart, and enforces each workflow's agreed access and approval rules. Local simulated acceptance and hosted real-wallet acceptance are separate results.

## Current behavior

Report and invoice (v3) is the default; Pay on merge (v2) remains selectable. Both enforce the failed-payment proof rule; their current privacy behavior still differs. Historical repair and other current gaps are listed in [PROGRESS.md](PROGRESS.md).

An optional Review assistant drafts observations and editable feedback from signed criteria and the submitted report. Using a draft fills the feedback field; requesting changes is a separate human action. The assistant does not verify linked work, propose compensation, sign or approve payment. The compensation assessor also treats evidence as supplied references rather than verified artifacts.

## Scope and open decisions

Paperwork provides bounded payment requests and explicit approval, without escrow or guaranteed payment. Funding the signed total does not establish an enduring provider-enforced total cap.

Organization-wide private access, automatic applications/bids, native internal-listing publication and a combined Market/job payment lifecycle are outside this scope.

The [recovery/acceptance plan](docs/recovery-acceptance.md) defines the recovery sequence, simulation layers and approved access boundary. Business outcome targets require product input; test passes alone do not supply them. See [TASKS.md](TASKS.md) for ongoing and proposed work and [README.md](README.md) for runnable workflows.
