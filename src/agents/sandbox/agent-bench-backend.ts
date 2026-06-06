import { randomUUID } from "node:crypto";
import type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
} from "./backend-handle.types.js";
import type {
  CreateSandboxBackendParams,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "./backend.types.js";
import {
  createRemoteShellSandboxFsBridge,
  type RemoteShellSandboxHandle,
} from "./remote-fs-bridge.js";
import { sanitizeEnvVars } from "./sanitize-env-vars.js";

export const AGENT_BENCH_TOOL_BRIDGE_ENDPOINT_ENV = "AGENT_BENCH_TOOL_BRIDGE_ENDPOINT";
export const AGENT_BENCH_TOOL_BRIDGE_LOG_PATH_ENV = "AGENT_BENCH_TOOL_BRIDGE_LOG_PATH";
export const AGENT_BENCH_SANDBOX_NAME_ENV = "AGENT_BENCH_SANDBOX_NAME";
export const AGENT_BENCH_SANDBOX_WORKDIR_ENV = "AGENT_BENCH_SANDBOX_WORKDIR";
export const AGENT_BENCH_SANDBOX_WORKSPACE_DIR_ENV = "AGENT_BENCH_SANDBOX_WORKSPACE_DIR";
export const AGENT_BENCH_SANDBOX_AGENT_WORKSPACE_DIR_ENV =
  "AGENT_BENCH_SANDBOX_AGENT_WORKSPACE_DIR";
export const AGENT_BENCH_TOOL_BRIDGE_COMMAND_TIMEOUT_MS_ENV =
  "AGENT_BENCH_TOOL_BRIDGE_COMMAND_TIMEOUT_MS";
export const AGENT_BENCH_RUN_ID_ENV = "AGENT_BENCH_RUN_ID";
export const AGENT_BENCH_RUN_NAME_ENV = "AGENT_BENCH_RUN_NAME";
export const AGENT_BENCH_BENCHMARK_KIND_ENV = "AGENT_BENCH_BENCHMARK_KIND";
export const AGENT_BENCH_BENCHMARK_TASK_ID_ENV = "AGENT_BENCH_BENCHMARK_TASK_ID";

const DEFAULT_TOOL_BRIDGE_TIMEOUT_MS = 300_000;

const BRIDGE_HTTP_PASS_THROUGH_ENV = [
  AGENT_BENCH_TOOL_BRIDGE_ENDPOINT_ENV,
  AGENT_BENCH_TOOL_BRIDGE_LOG_PATH_ENV,
  AGENT_BENCH_TOOL_BRIDGE_COMMAND_TIMEOUT_MS_ENV,
  AGENT_BENCH_SANDBOX_NAME_ENV,
  AGENT_BENCH_SANDBOX_WORKDIR_ENV,
  AGENT_BENCH_SANDBOX_WORKSPACE_DIR_ENV,
  AGENT_BENCH_SANDBOX_AGENT_WORKSPACE_DIR_ENV,
  AGENT_BENCH_RUN_ID_ENV,
  AGENT_BENCH_RUN_NAME_ENV,
  AGENT_BENCH_BENCHMARK_KIND_ENV,
  AGENT_BENCH_BENCHMARK_TASK_ID_ENV,
] as const;

type AgentBenchBridgeRuntime = {
  endpoint: string;
  sandboxName: string;
  workdir: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  commandTimeoutMs?: number;
};

export type AgentBenchBridgeHttpClientArgvParams = {
  cwd: string;
  argv: readonly string[];
  env: Record<string, string>;
  timeoutMs?: number;
};

type AgentBenchToolBridgeExecRequest = {
  type: "exec";
  id: string;
  cwd: string;
  argv: readonly string[];
  env: Record<string, string>;
  stdin_b64: string | null;
  timeout_ms: number;
};

type AgentBenchToolBridgeExecResult = {
  type: "exec_result";
  id: string;
  exitCode: number;
  stdoutB64: string;
  stderrB64: string;
  timedOut: boolean;
};

const HTTP_EXEC_CLIENT_SOURCE = String.raw`
import { randomUUID } from "node:crypto";

const ENDPOINT_ENV = "AGENT_BENCH_TOOL_BRIDGE_ENDPOINT";

function fail(message) {
  process.stderr.write(String(message).trim() + "\n");
  process.exit(1);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail("Agent Bench HTTP bridge client requires " + name + ".");
  }
  return value;
}

function resolveExecUrl(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch (error) {
    fail("Agent Bench tool bridge endpoint must be a valid URL: " + String(error));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail("Agent Bench tool bridge endpoint must use http:// or https://.");
  }
  if (url.hostname !== "127.0.0.1") {
    fail("Agent Bench tool bridge endpoint must use host-loopback 127.0.0.1.");
  }
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (!normalizedPath || normalizedPath === "/") {
    url.pathname = "/v1/exec";
  } else if (normalizedPath === "/v1") {
    url.pathname = "/v1/exec";
  } else if (normalizedPath !== "/v1/exec") {
    fail("Agent Bench tool bridge endpoint path must be /, /v1, or /v1/exec.");
  }
  return url.toString();
}

function parseJsonOption(args, name, fallback) {
  const value = option(args, name);
  if (value === undefined) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    fail("Invalid " + name + ": " + String(error));
  }
}

function parsePositiveTimeoutMs(args) {
  const value = option(args, "--timeout-ms");
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail("Agent Bench HTTP bridge client requires --timeout-ms to be a positive integer.");
  }
  return Math.floor(parsed);
}

function normalizeResponse(value, requestId) {
  if (!value || typeof value !== "object") {
    fail("Agent Bench tool bridge returned a non-object response.");
  }
  if (value.type !== "exec_result") {
    fail("Agent Bench tool bridge returned unexpected response type.");
  }
  if (value.id !== requestId) {
    fail("Agent Bench tool bridge response id does not match request id.");
  }
  const exitCode = Number(value.exit_code);
  if (!Number.isInteger(exitCode) || exitCode < 0) {
    fail("Agent Bench tool bridge response exit_code must be a non-negative integer.");
  }
  return {
    exitCode,
    stdoutB64: typeof value.stdout_b64 === "string" ? value.stdout_b64 : "",
    stderrB64: typeof value.stderr_b64 === "string" ? value.stderr_b64 : "",
    timedOut: value.timed_out === true,
  };
}

const args = process.argv.slice(1);
if (args[0] === "--") {
  args.shift();
}
if (args[0] === "exec") {
  args.shift();
}

const cwd = option(args, "--cwd");
if (!cwd) {
  fail("Agent Bench HTTP bridge client requires --cwd.");
}
const argv = parseJsonOption(args, "--argv-json", []);
if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
  fail("Agent Bench HTTP bridge client requires --argv-json to be a string array.");
}
const env = parseJsonOption(args, "--env-json", {});
if (!env || typeof env !== "object" || Array.isArray(env)) {
  fail("Agent Bench HTTP bridge client requires --env-json to be an object.");
}

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
}
const stdin = Buffer.concat(chunks);
const id = randomUUID();
const request = {
  type: "exec",
  id,
  cwd,
  argv,
  env,
  stdin_b64: stdin.length > 0 ? stdin.toString("base64") : null,
  timeout_ms: parsePositiveTimeoutMs(args),
};

const response = await fetch(resolveExecUrl(requireEnv(ENDPOINT_ENV)), {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify(request),
});

if (!response.ok) {
  fail("Agent Bench tool bridge request failed with HTTP " + response.status + ": " + await response.text());
}

const result = normalizeResponse(await response.json(), id);
const stdout = Buffer.from(result.stdoutB64, "base64");
const stderr = Buffer.from(result.stderrB64, "base64");
process.stdout.write(stdout);
process.stderr.write(
  result.timedOut && stderr.length === 0
    ? Buffer.from("Agent Bench tool bridge command timed out.\n")
    : stderr,
);
process.exit(Math.min(result.timedOut && result.exitCode === 0 ? 124 : result.exitCode, 255));
`;

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requireEnv(name: string): string {
  const value = readTrimmedEnv(name);
  if (!value) {
    throw new Error(`Agent Bench sandbox backend requires ${name}.`);
  }
  return value;
}

function parsePositiveIntegerEnv(name: string): number | undefined {
  const value = readTrimmedEnv(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Agent Bench sandbox backend requires ${name} to be a positive integer.`);
  }
  return Math.floor(parsed);
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function resolveRequestTimeoutMs(...candidates: Array<number | undefined>): number {
  for (const candidate of candidates) {
    const normalized = normalizePositiveInteger(candidate);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return DEFAULT_TOOL_BRIDGE_TIMEOUT_MS;
}

function resolveToolBridgeExecUrl(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new Error(`Agent Bench tool bridge endpoint must be a valid URL: ${String(error)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Agent Bench tool bridge endpoint must use http:// or https://.");
  }
  if (url.hostname !== "127.0.0.1") {
    throw new Error("Agent Bench tool bridge endpoint must use host-loopback 127.0.0.1.");
  }
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (!normalizedPath || normalizedPath === "/") {
    url.pathname = "/v1/exec";
  } else if (normalizedPath === "/v1") {
    url.pathname = "/v1/exec";
  } else if (normalizedPath !== "/v1/exec") {
    throw new Error("Agent Bench tool bridge endpoint path must be /, /v1, or /v1/exec.");
  }
  return url.toString();
}

function resolveAgentBenchRuntime(params: CreateSandboxBackendParams): AgentBenchBridgeRuntime {
  const workdir = readTrimmedEnv(AGENT_BENCH_SANDBOX_WORKDIR_ENV) ?? params.cfg.docker.workdir;
  const workspaceDir = readTrimmedEnv(AGENT_BENCH_SANDBOX_WORKSPACE_DIR_ENV) ?? workdir;
  const agentWorkspaceDir =
    readTrimmedEnv(AGENT_BENCH_SANDBOX_AGENT_WORKSPACE_DIR_ENV) ?? workspaceDir;

  return {
    endpoint: resolveToolBridgeExecUrl(requireEnv(AGENT_BENCH_TOOL_BRIDGE_ENDPOINT_ENV)),
    sandboxName: requireEnv(AGENT_BENCH_SANDBOX_NAME_ENV),
    workdir,
    workspaceDir,
    agentWorkspaceDir,
    commandTimeoutMs: parsePositiveIntegerEnv(AGENT_BENCH_TOOL_BRIDGE_COMMAND_TIMEOUT_MS_ENV),
  };
}

function buildBridgeHttpClientEnv(
  runtime: AgentBenchBridgeRuntime,
  sessionKey: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...sanitizeEnvVars(process.env).allowed,
    OPENCLAW_SESSION_KEY: sessionKey,
  };
  for (const key of BRIDGE_HTTP_PASS_THROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env[AGENT_BENCH_TOOL_BRIDGE_ENDPOINT_ENV] = runtime.endpoint;
  env[AGENT_BENCH_SANDBOX_NAME_ENV] = runtime.sandboxName;
  env[AGENT_BENCH_SANDBOX_WORKDIR_ENV] = runtime.workdir;
  env[AGENT_BENCH_SANDBOX_WORKSPACE_DIR_ENV] = runtime.workspaceDir;
  env[AGENT_BENCH_SANDBOX_AGENT_WORKSPACE_DIR_ENV] = runtime.agentWorkspaceDir;
  return env;
}

export function buildAgentBenchBridgeHttpClientArgv(
  params: AgentBenchBridgeHttpClientArgvParams,
): string[] {
  return [
    process.execPath,
    "--input-type=module",
    "--eval",
    HTTP_EXEC_CLIENT_SOURCE,
    "--",
    "exec",
    "--cwd",
    params.cwd,
    "--argv-json",
    JSON.stringify(params.argv),
    "--env-json",
    JSON.stringify(params.env),
    "--timeout-ms",
    String(resolveRequestTimeoutMs(params.timeoutMs)),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseExecResult(value: unknown, requestId: string): AgentBenchToolBridgeExecResult {
  if (!isRecord(value)) {
    throw new Error("Agent Bench tool bridge returned a non-object response.");
  }
  if (value.type !== "exec_result") {
    throw new Error("Agent Bench tool bridge returned unexpected response type.");
  }
  if (value.id !== requestId) {
    throw new Error("Agent Bench tool bridge response id does not match request id.");
  }
  const exitCode = Number(value.exit_code);
  if (!Number.isInteger(exitCode) || exitCode < 0) {
    throw new Error("Agent Bench tool bridge response exit_code must be a non-negative integer.");
  }
  return {
    type: "exec_result",
    id: requestId,
    exitCode,
    stdoutB64: typeof value.stdout_b64 === "string" ? value.stdout_b64 : "",
    stderrB64: typeof value.stderr_b64 === "string" ? value.stderr_b64 : "",
    timedOut: value.timed_out === true,
  };
}

async function postExecRequest(params: {
  runtime: AgentBenchBridgeRuntime;
  cwd: string;
  argv: readonly string[];
  env?: Record<string, string>;
  stdin?: Buffer | string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<SandboxBackendCommandResult> {
  const stdin =
    params.stdin === undefined
      ? null
      : Buffer.isBuffer(params.stdin)
        ? params.stdin
        : Buffer.from(params.stdin);
  const request: AgentBenchToolBridgeExecRequest = {
    type: "exec",
    id: randomUUID(),
    cwd: params.cwd,
    argv: params.argv,
    env: params.env ?? {},
    stdin_b64: stdin && stdin.length > 0 ? stdin.toString("base64") : null,
    timeout_ms: resolveRequestTimeoutMs(params.timeoutMs, params.runtime.commandTimeoutMs),
  };

  const response = await fetch(params.runtime.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
    signal: params.signal,
  });
  if (!response.ok) {
    throw new Error(
      `Agent Bench tool bridge request failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }

  const result = parseExecResult(await response.json(), request.id);
  const stdout = Buffer.from(result.stdoutB64, "base64");
  const stderr = Buffer.from(result.stderrB64, "base64");
  return {
    stdout,
    stderr:
      result.timedOut && stderr.length === 0
        ? Buffer.from("Agent Bench tool bridge command timed out.\n")
        : stderr,
    code: result.timedOut && result.exitCode === 0 ? 124 : result.exitCode,
  };
}

export const agentBenchSandboxBackendManager: SandboxBackendManager = {
  async describeRuntime({ entry }) {
    const sandboxName = readTrimmedEnv(AGENT_BENCH_SANDBOX_NAME_ENV);
    return {
      running: Boolean(sandboxName),
      actualConfigLabel: sandboxName,
      configLabelMatch: sandboxName ? entry.image === sandboxName : false,
    };
  },
  async removeRuntime() {
    // Agent Bench owns sandbox lifecycle; OpenClaw must never prune or remove it.
  },
};

export async function createAgentBenchSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  const runtime = resolveAgentBenchRuntime(params);
  const handle: SandboxBackendHandle & RemoteShellSandboxHandle = {
    id: "agent-bench",
    runtimeId: runtime.sandboxName,
    runtimeLabel: runtime.sandboxName,
    workdir: runtime.workdir,
    configLabel: runtime.sandboxName,
    configLabelKind: "Sandbox",
    remoteWorkspaceDir: runtime.workspaceDir,
    remoteAgentWorkspaceDir: runtime.agentWorkspaceDir,
    buildExecSpec: async ({ command, workdir, env, timeoutMs }) => ({
      argv: buildAgentBenchBridgeHttpClientArgv({
        cwd: workdir ?? runtime.workdir,
        argv: ["/bin/sh", "-lc", command],
        env,
        timeoutMs: resolveRequestTimeoutMs(timeoutMs, runtime.commandTimeoutMs),
      }),
      env: buildBridgeHttpClientEnv(runtime, params.sessionKey),
      stdinMode: "pipe-open",
    }),
    runShellCommand: async (command) => {
      const result = await postExecRequest({
        runtime,
        cwd: runtime.workspaceDir,
        argv: ["/bin/sh", "-c", command.script, "openclaw-sandbox-fs", ...(command.args ?? [])],
        stdin: command.stdin,
        timeoutMs: runtime.commandTimeoutMs,
        signal: command.signal,
      });
      if (result.code !== 0 && !command.allowFailure) {
        throw Object.assign(
          new Error(
            result.stderr.toString("utf8").trim() ||
              `Agent Bench tool bridge exited with code ${result.code}.`,
          ),
          result,
        );
      }
      return result;
    },
    createFsBridge: ({ sandbox }) =>
      createRemoteShellSandboxFsBridge({
        sandbox,
        runtime: handle,
      }),
    runRemoteShellScript: async (command: SandboxBackendCommandParams) =>
      await handle.runShellCommand(command),
  };
  return handle;
}
