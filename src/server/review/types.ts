import type { HermesReviewConfig } from "./hermes";

/** Public gateway; direct model endpoints and alternate credential destinations are not accepted. */
export const NEAR_AI_BASE_URL = "https://cloud-api.near.ai/v1";
export const DEFAULT_REVIEW_MODEL = "z-ai/glm-5.3-flash";

export interface NearReviewConfig {
  backend: "near";
  url: typeof NEAR_AI_BASE_URL;
  apiKey: string;
  model: string;
  provider: "near";
  timeoutMs: number;
}

/** Existing isolated Hermes fixtures remain usable; the direct backend is selected explicitly. */
export type ReviewServiceConfig = NearReviewConfig | (HermesReviewConfig & { backend?: "hermes" });
