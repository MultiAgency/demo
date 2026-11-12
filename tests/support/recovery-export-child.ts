import { readFileSync, writeSync } from "node:fs";
import { exportRestorationBundle } from "../../src/server/recovery/export";
import type { RestorationRequest } from "../../src/server/recovery/restore";

// This subprocess helper is used only with disposable fixtures. No production CLI flag or environment hook exists.
const [source, requestPath, target, stopAt] = Bun.argv.slice(2);
if (!source || !requestPath || !target || !["before_publish", "after_publish"].includes(stopAt ?? "")) process.exit(2);
const request = JSON.parse(readFileSync(requestPath, "utf8")) as RestorationRequest;
const result = exportRestorationBundle(source, request, target, {
  now: () => new Date(request.collection.completed_at),
  onPhase: phase => {
    if (phase !== stopAt) return;
    writeSync(1, `PHASE ${phase}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
});
writeSync(1, `${JSON.stringify(result)}\n`);
