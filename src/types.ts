/**
 * Shared types for deer. These match the JSON contract with deerbox CLI.
 */

export interface ProxyCredential {
  domain: string;
  target: string;
  hostEnv: { key: string };
  headerTemplate: Record<string, string>;
  sandboxEnv: { key: string; value: string };
}

export interface DeerConfig {
  defaults: {
    agent: "claude";
    baseBranch?: string;
    /** @default 1800000 */
    timeoutMs?: number;
    setupCommand?: string;
  };
  network: {
    allowlist: string[];
  };
  sandbox: {
    /** @default "srt" */
    runtime: "srt";
    envPassthrough: string[];
    proxyCredentials: ProxyCredential[];
    ecosystems?: {
      /** @default [] */
      disabled?: string[];
    };
  };
}

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  credentialType: "subscription" | "api-token" | "none";
}

export interface PrepareResult {
  taskId: string;
  worktreePath: string;
  branch: string;
  command: string[];
  authProxyPid: number | null;
}
