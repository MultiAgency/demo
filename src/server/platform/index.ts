import type { PlatformConfig, PlatformKit } from "./port";

/** Track A replaces this stub with the fake / SDK-backed implementations. */
export function makePlatform(_cfg: PlatformConfig): PlatformKit {
  throw new Error("makePlatform is not implemented yet (track A)");
}
