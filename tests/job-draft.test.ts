import { expect, test } from "bun:test";
import { jobDraftKey, readJobDraft, saveJobDraft, type JobDraft } from "../src/web/job-draft";

const draft: JobDraft = { workflow: "report_and_invoice", title: "", description: "", company: "Unfinished agency", rep: "acme.demo", dao: "", contractorName: "", github: "", contractorAccount: "", payee: "", start: "", end: "", reviewDays: "", repos: "", scope: [] };
const storage = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } }; };

test("unfinished drafts survive restoration under their own account and cannot cross account keys", () => {
  const store = storage();
  expect(saveJobDraft(store, jobDraftKey("acme.demo"), draft)).toBe(true);
  expect(readJobDraft(store, jobDraftKey("acme.demo"))).toEqual(draft);
  expect(readJobDraft(store, jobDraftKey("other.demo"))).toBeNull();
});

test("malformed, oversized or unavailable storage fails without restoring unvalidated form data", () => {
  for (const raw of ["{", "null", '{"company":"incomplete"}', "x".repeat(256_001)])
    expect(readJobDraft({ getItem: () => raw }, "key")).toBeNull();
  expect(readJobDraft({ getItem: () => { throw Error("unavailable"); } }, "key")).toBeNull();
  expect(saveJobDraft({ setItem: () => { throw Error("quota"); } }, "key", draft)).toBe(false);
  expect(saveJobDraft(storage(), "key", { ...draft, company: "x".repeat(20_001) })).toBe(false);
});

test("stored drafts retain form fields but discard invitation tokens and signing data", () => {
  const result = readJobDraft({ getItem: () => JSON.stringify({ ...draft, contractor_token: "private-link", signature: "signed-payload" }) }, "key");
  expect(result).toEqual(draft);
});

test("a draft saved before titles and review windows existed still restores, with those fields empty", () => {
  const store = storage();
  const { title: _title, description: _description, reviewDays: _reviewDays, ...older } = draft;
  store.setItem(jobDraftKey("acme.demo"), JSON.stringify(older));
  expect(readJobDraft(store, jobDraftKey("acme.demo"))).toEqual(draft);
});
