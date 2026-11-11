import { defineRailway, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  // The database's volume. Renaming it here doesn't rename it: apply creates a new, empty volume and mounts it at /data,
  // leaving the database (every saved requestId, vote and job) on the old one, detached. Volumes are never deleted by apply.
  const data = volume("server-volume", { region: "us-west2", sizeMB: 5000 });

  const server = service("server", {
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/api/health",
    healthcheckTimeout: 60,
    // One replica: SQLite has one writer, and the timers that follow payouts, hires and jobs run in this process.
    replicas: { "us-west2": 1 },
    // No requiredMountPath: Railway keeps it unset when set from here (as for Treasury's service), so the server checks
    // the volume itself (REQUIRED_MOUNT, src/server/config.ts).
    volumeMounts: { "/data": data },
    // Values are set in Railway (docs/deploy.md), never here.
    env: {
      PLATFORM: preserve(),
      PLATFORM_URL: preserve(),
      PLATFORM_DEPLOYMENT: preserve(),
      PLATFORM_CREDENTIAL: preserve(),
      REQUIRED_MOUNT: preserve(),
      DB_PATH: preserve(),
      PUBLIC_URL: preserve(),
      BETTER_AUTH_SECRET: preserve(),
      SIWN_RECIPIENT: preserve(),
      NEAR_RPC_URL: preserve(),
      GITHUB: preserve(),
      GITHUB_TOKEN: preserve(),
      NEARAI_API_KEY: preserve(),
      MARKET_URL: preserve(),
      MARKET_AGENT_TOKEN: preserve(),
      MARKET_WEBHOOK_SECRET: preserve(),
      MARKET_WORKER_AGENCY: preserve(),
    },
  });

  return project("jobs", { resources: [server, data] });
});
