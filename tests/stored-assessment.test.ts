import { expect, test } from "bun:test";
import { DEMO_TERMS } from "../src/shared/demo";
import { activate } from "./support/harness";

// Offline fixtures only. A stored assessment is edited in place to model a record this version did not write.
const rows = (ctx: Awaited<ReturnType<typeof activate>>) => ["judgments", "payout_attempts", "payout_lines"]
  .map((table) => ctx.rt.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());

for (const [label, rewrite] of [
  ["a completion outside the agreed levels", (json: string) => json.replace(/"completion":[\d.]+/, '"completion":5')],
  ["a record without deliverables", () => '{"fixture":"original assessment"}'],
  ["text that is not JSON", () => "private-assessment-json"],
] as const) {
  test(`${label} stops the job read instead of becoming an amount`, async () => {
    const ctx = await activate("1000", { ...DEMO_TERMS, scope: [DEMO_TERMS.scope[0]!] });
    try {
      const run = await ctx.rt.engine.run(ctx.id);
      expect(run.payouts).toHaveLength(1);
      const stored = ctx.rt.db.query("SELECT id, json FROM judgments WHERE contract_id = ?").get(ctx.id) as { id: string; json: string };
      ctx.rt.db.query("UPDATE judgments SET json = ? WHERE id = ?").run(rewrite(stored.json), stored.id);
      const before = rows(ctx);
      await expect(ctx.rt.engine.viewContract(ctx.id)).rejects.toThrow("A stored assessment is unreadable.");
      expect(rows(ctx)).toEqual(before);
    } finally { await ctx.rt.close(); }
  });
}
