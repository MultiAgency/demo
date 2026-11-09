// FROZEN: the driver contract shared by demo-e2e (fake, track B) and demo-stack (local stack, track A).
import type { DemoControls, OwnerSigner } from "../src/server/platform/port";

export interface ScenarioDriver {
  name: "fake" | "stack";
  base: string; // Covenant API base, e.g. http://localhost:8781/api
  signer(account: string): OwnerSigner; // terms + platform NEP-413
  controls: DemoControls;
  termsWindow: { start: string; end: string };
  payee: string;
  rep: string;
  attacker: string;
}

// scripts/scenario.ts (track B): export async function runScenario(d: ScenarioDriver): Promise<string[] /* failures */>
