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
