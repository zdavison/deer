import type { DeerConfig } from "../config";
import type { SandboxRuntime } from "./runtime";
import { createSrtRuntime } from "./srt";

/**
 * Resolve a SandboxRuntime from the config's runtime name.
 */
export function resolveRuntime(config: DeerConfig): SandboxRuntime {
  switch (config.sandbox.runtime) {
    case "srt":
      return createSrtRuntime();
    default:
      throw new Error(`Unknown sandbox runtime: ${config.sandbox.runtime}`);
  }
}
