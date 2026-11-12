import { expect, test } from "bun:test";
import { loadConfig } from "../src/server/config";

const configured = {
  PAPERWORK_HERMES_URL: "https://review.example.test",
  PAPERWORK_HERMES_API_KEY: "fixture-review-api-key",
  PAPERWORK_HERMES_MODEL: "fixture-current-model",
};

test("review integration is opt-in and requires both server settings", () => {
  expect(loadConfig({}).review).toBeNull();
  expect(() => loadConfig({ PAPERWORK_HERMES_URL: configured.PAPERWORK_HERMES_URL })).toThrow("together");
  expect(() => loadConfig({ PAPERWORK_HERMES_API_KEY: configured.PAPERWORK_HERMES_API_KEY })).toThrow("together");
  expect(loadConfig(configured).review).toEqual({
    url: "https://review.example.test", apiKey: "fixture-review-api-key", model: "fixture-current-model",
    provider: "custom:near", timeoutMs: 90_000,
  });
});

test("review transport refuses insecure remote hosts, ambiguous paths and invalid deadlines", () => {
  for (const url of ["http://review.example.test", "https://user:password@review.example.test", "https://review.example.test/v1", "https://review.example.test/?token=secret"]) {
    expect(() => loadConfig({ ...configured, PAPERWORK_HERMES_URL: url })).toThrow();
  }
  expect(loadConfig({ ...configured, PAPERWORK_HERMES_URL: "http://127.0.0.1:8642" }).review?.url).toBe("http://127.0.0.1:8642");
  expect(loadConfig({ ...configured, PAPERWORK_HERMES_URL: "https://review.example.test/p/review-only/" }).review?.url).toBe("https://review.example.test/p/review-only");
  for (const timeout of ["0", "NaN", "1000.5", "300001"]) {
    expect(() => loadConfig({ ...configured, PAPERWORK_REVIEW_TIMEOUT_MS: timeout })).toThrow("PAPERWORK_REVIEW_TIMEOUT_MS");
  }
});

const near = { PAPERWORK_REVIEW_BACKEND: "near", PAPERWORK_REVIEW_NEARAI_API_KEY: "fixture-near-review-key" };

test("direct NEAR review uses a separate opt-in credential and a fixed public gateway", () => {
  const config = loadConfig(near);
  expect(config.review).toEqual({ backend: "near", url: "https://cloud-api.near.ai/v1", provider: "near",
    apiKey: "fixture-near-review-key", model: "z-ai/glm-5.3-flash", timeoutMs: 120_000 });
  expect(config.judge.kind).toBe("rules");
  expect(config.judge.apiKey).toBeNull();
  expect(loadConfig({ NEARAI_API_KEY: "fixture-existing-judge-key" }).review).toBeNull();
  expect(loadConfig({ PAPERWORK_REVIEW_NEARAI_API_KEY: near.PAPERWORK_REVIEW_NEARAI_API_KEY }).review?.backend).toBe("near");
  expect(loadConfig({ ...near, NEARAI_BASE_URL: "https://other.invalid", NEARAI_MODEL: "other/model" }).review?.url).toBe("https://cloud-api.near.ai/v1");
  expect(loadConfig({ ...near, NEARAI_MODEL: "other/model" }).review?.model).toBe("z-ai/glm-5.3-flash");
});

test("backend selection rejects ambiguity and incomplete credentials without falling back", () => {
  expect(() => loadConfig({ PAPERWORK_REVIEW_BACKEND: "other" })).toThrow("PAPERWORK_REVIEW_BACKEND");
  expect(() => loadConfig({ PAPERWORK_REVIEW_BACKEND: "near" })).toThrow("PAPERWORK_REVIEW_NEARAI_API_KEY");
  expect(() => loadConfig({ PAPERWORK_REVIEW_BACKEND: "hermes" })).toThrow("together");
  expect(() => loadConfig({ ...near, PAPERWORK_REVIEW_BACKEND: "hermes" })).toThrow("Remove");
  expect(() => loadConfig({ ...configured, PAPERWORK_REVIEW_NEARAI_API_KEY: near.PAPERWORK_REVIEW_NEARAI_API_KEY })).toThrow("Select");
  expect(loadConfig({ ...configured, ...near }).review?.backend).toBe("near");
});

test("direct NEAR settings validate model IDs, credentials and review deadlines", () => {
  for (const key of ["short", "x".repeat(4097), "fixture-key\nmalicious", "fixture key with spaces"])
    expect(() => loadConfig({ ...near, PAPERWORK_REVIEW_NEARAI_API_KEY: key })).toThrow("review API key");
  for (const model of ["https://other.invalid/model", " model", "x".repeat(201)])
    expect(() => loadConfig({ ...near, PAPERWORK_REVIEW_MODEL: model })).toThrow("PAPERWORK_REVIEW_MODEL");
  expect(loadConfig({ ...near, PAPERWORK_REVIEW_MODEL: "fixture/canonical-model" }).review?.model).toBe("fixture/canonical-model");
  for (const timeout of ["0", "999", "NaN", "1000.5", "300001"])
    expect(() => loadConfig({ ...near, PAPERWORK_REVIEW_TIMEOUT_MS: timeout })).toThrow("PAPERWORK_REVIEW_TIMEOUT_MS");
  expect(loadConfig({ ...near, PAPERWORK_REVIEW_TIMEOUT_MS: "300000" }).review?.timeoutMs).toBe(300_000);
});
