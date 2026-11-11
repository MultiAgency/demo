import { expect, test } from "bun:test";
import { loadConfig, volumeProblem } from "../src/server/config";

const mount = { REQUIRED_MOUNT: "/data", RAILWAY_VOLUME_MOUNT_PATH: "/data" };

test("a required volume rejects the effective default database outside its mount", () => {
  expect(volumeProblem(mount)).toContain("DB_PATH must be on the volume");
  expect(() => loadConfig({ ...mount, PLATFORM: "remote" })).toThrow("DB_PATH must be on the volume");
  expect(() => loadConfig({ ...mount, PLATFORM: "fake" })).toThrow("DB_PATH must be on the volume");
});

test("database containment uses normalized paths rather than a string prefix", () => {
  for (const DB_PATH of ["/data/../tmp/jobs.sqlite", "/data-other/jobs.sqlite", "/data", ":memory:"])
    expect(volumeProblem({ ...mount, DB_PATH })).toContain("DB_PATH must be on the volume");
  expect(volumeProblem({ ...mount, DB_PATH: "/data/state/../jobs.sqlite" })).toBeNull();
  expect(volumeProblem({ ...mount, DB_PATH: "/data/jobs.sqlite" })).toBeNull();
});

test("mount identity is checked before permitting durable database startup", () => {
  expect(volumeProblem({ ...mount, RAILWAY_VOLUME_MOUNT_PATH: "/elsewhere", DB_PATH: "/data/jobs.sqlite" })).toContain("No volume is mounted");
  expect(volumeProblem({ ...mount, RAILWAY_VOLUME_MOUNT_PATH: "data", DB_PATH: "/data/jobs.sqlite" })).toContain("No volume is mounted");
  expect(volumeProblem({ ...mount, REQUIRED_MOUNT: "data", DB_PATH: "/data/jobs.sqlite" })).toContain("absolute path");
  expect(volumeProblem({ ...mount, REQUIRED_MOUNT: "/data/", DB_PATH: "/data/jobs.sqlite" })).toBeNull();
  expect(volumeProblem({})).toBeNull();
});
