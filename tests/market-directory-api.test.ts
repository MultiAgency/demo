import { expect, test } from "bun:test";
import { MarketApi, MarketHttpError } from "../src/server/market/api";

// Offline fixtures shaped by the Market's published OpenAPI 2.0.0 (read 2026-11-14). No Market account or hosted request.
const date = "2026-11-11T12:00:00.123Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const agent = (extra: Record<string, unknown> = {}) => ({
  agent_id: uuid(1), owner_account_id: uuid(900), handle: "csv-builder", name: "CSV Builder", category: "data", tags: [],
  runtime: "managed", listing_status: "live", delivered_jobs: 4, sla_seconds: 3600, required_slots: [], funding_paused: false,
  availability: "available", created_at: date, updated_at: date, description: null, success_rate: null, ...extra,
});
const plan = (extra: Record<string, unknown> = {}) => ({
  pricing_plan_id: uuid(2), agent_id: uuid(1), model: "per_call", price_amount: "12.00", is_default: true,
  listing_status: "live", created_at: date, updated_at: date, display_name: null, sla_seconds: null, ...extra,
});
const reputation = { axes: {}, jobs_counted: 7, min_scored_jobs: 5, min_answered_reviews: 5, overall: 4.5, baseline: null };
const assignment = (extra: Record<string, unknown> = {}) => ({
  assignment: { assignmentId: "assignment-1", jobId: "job-1", status: "in_progress", escrowAmount: "25.000000", escrowToken: "USDC", slaDeadlineAt: date, ...extra },
  job: { title: "Private job", description: "Private brief" },
});

/** Answers each path from `routes`; an absent path is the Market's 404. */
const client = (routes: Record<string, unknown>) => new MarketApi("https://market.invalid", "aat_offline_directory_fixture", (async (input: string | URL | Request) => {
  const path = new URL(String(input)).pathname;
  return path in routes ? Response.json(routes[path]) : Response.json({ error: "not_found" }, { status: 404 });
}) as unknown as typeof fetch);
const invalid = async (read: Promise<unknown>) => {
  const error = await read.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(MarketHttpError);
  expect((error as MarketHttpError).status).toBe(200);
};

test("the directory keeps only the listed agent's public summary fields", async () => {
  const agents = await client({ "/v1/agents": { agents: [agent({ description: "Exports CSV reports.", success_rate: 98, secret: "PRIVATE" })] } }).browse("csv");
  expect(agents).toEqual([{ agent_id: uuid(1), handle: "csv-builder", name: "CSV Builder", description: "Exports CSV reports.", sla_seconds: 3600, delivered_jobs: 4, success_rate: 98 }]);
});

test("an unreadable directory answer is a failed Market read, never an invented agent", async () => {
  for (const body of [null, {}, { agents: {} }, { agents: [null] }, { agents: [agent({ agent_id: undefined })] },
    { agents: [agent({ handle: 7 })] }, { agents: [agent({ sla_seconds: "soon" })] }, { agents: [agent({ delivered_jobs: undefined })] }])
    await invalid(client({ "/v1/agents": body }).browse("csv"));
});

test("an agent's plans and reputation are read as published; a missing reputation is not a failure", async () => {
  const plans = `/v1/agents/${uuid(1)}/pricing-plans`;
  const rep = `/v1/agents/${uuid(1)}/reputation`;
  expect(await client({ [plans]: [plan({ display_name: "Standard", sla_seconds: 600 })], [rep]: reputation }).detail(uuid(1))).toEqual({
    plans: [{ name: "Standard", model: "per_call", price_amount: "12.00", is_default: true, sla_seconds: 600 }],
    reputation: { overall: 4.5, jobs_counted: 7 },
  });
  expect(await client({ [plans]: [plan()] }).detail(uuid(1))).toEqual({
    plans: [{ name: null, model: "per_call", price_amount: "12.00", is_default: true, sla_seconds: null }], reputation: null,
  });
});

test("an unreadable plan or reputation answer is a failed Market read, never an invented price", async () => {
  const plans = `/v1/agents/${uuid(1)}/pricing-plans`;
  const rep = `/v1/agents/${uuid(1)}/reputation`;
  for (const body of [null, { plans: [] }, [null], [plan({ price_amount: undefined })], [plan({ price_amount: 12 })], [plan({ model: undefined })]])
    await invalid(client({ [plans]: body, [rep]: reputation }).detail(uuid(1)));
  for (const body of [[], { ...reputation, jobs_counted: undefined }, { ...reputation, overall: "high" }])
    await invalid(client({ [plans]: [plan()], [rep]: body }).detail(uuid(1)));
});

test("assignments keep their identity and tolerate the absent optional fields existing records rely on", async () => {
  const path = "/v1/agents/me/assignments";
  expect(await client({ [path]: { assignments: [assignment()] } }).assignments()).toEqual([{
    assignmentId: "assignment-1", jobId: "job-1", status: "in_progress", escrowAmount: "25.000000", escrowToken: "USDC",
    slaDeadlineAt: date, title: "Private job", description: "Private brief",
  }]);
  const sparse = { assignment: { assignmentId: "assignment-2", jobId: "job-2", status: "submitted", escrowAmount: null }, job: {} };
  expect(await client({ [path]: { assignments: [sparse] } }).assignments()).toEqual([{
    assignmentId: "assignment-2", jobId: "job-2", status: "submitted", escrowAmount: null, escrowToken: null, slaDeadlineAt: null, title: "", description: "",
  }]);
});

test("an assignment without a readable identity or status is a failed read, never a stored placeholder", async () => {
  for (const body of [null, {}, { assignments: {} }, { assignments: [null] }, { assignments: [{ job: {} }] },
    { assignments: [assignment({ assignmentId: undefined })] }, { assignments: [assignment({ jobId: "" })] },
    { assignments: [assignment({ status: undefined })] }, { assignments: [assignment({ escrowAmount: 25 })] }])
    await invalid(client({ "/v1/agents/me/assignments": body }).assignments());
});
