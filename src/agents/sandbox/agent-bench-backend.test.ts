import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_BENCH_OPENCLAW_TOOL_CONFIG_PATH_ENV,
  AGENT_BENCH_SANDBOX_NAME_ENV,
  AGENT_BENCH_TOOL_BRIDGE_ENDPOINT_ENV,
  AGENT_BENCH_TOOL_SERVICE_ENDPOINT_ENV,
  agentBenchSandboxBackendManager,
  buildAgentBenchBridgeHttpClientArgv,
  createAgentBenchSandboxBackend,
} from "./agent-bench-backend.js";
import type { CreateSandboxBackendParams } from "./backend.types.js";
import { createSandboxTestContext } from "./test-fixtures.js";
import type { SandboxConfig } from "./types.js";

const BINARY_READ_OUTPUT = Buffer.from([0, 255, 1, 2, 3]);

type ExecRequestBody = {
  type: "exec";
  id: string;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  stdin_b64: string | null;
  timeout_ms: number;
};

type ExecResponseBody = {
  type: "exec_result";
  id: string;
  exit_code: number;
  stdout_b64: string;
  stderr_b64: string;
  timed_out: boolean;
};

type CapturedBridgeRequest = {
  authorization: string | undefined;
  method: string | undefined;
  url: string | undefined;
  body: ExecRequestBody;
};

type ToolCallRequestBody = {
  type: "tool_call";
  id: string;
  canonical_tool: string;
  input: Record<string, unknown>;
  metadata: Record<string, string>;
};

type ToolCallResponseBody = {
  type: "tool_result";
  id: string;
  canonical_tool: string;
  ok: boolean;
  output: Record<string, unknown>;
  error?: string;
};

type CapturedToolCallRequest = {
  method: string | undefined;
  url: string | undefined;
  body: ToolCallRequestBody;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agent-bench sandbox backend", () => {
  it("builds embedded HTTP bridge argv with structured cwd, argv, env, and timeout", () => {
    const argv = buildAgentBenchBridgeHttpClientArgv({
      cwd: "/app",
      argv: ["/bin/sh", "-lc", "echo hello"],
      env: { FOO: "bar" },
      timeoutMs: 1234,
    });

    expect(argv[0]).toBe(process.execPath);
    expect(argv).toContain("--input-type=module");
    expect(argv).toContain("--eval");
    expect(argv).toContain("exec");
    expect(optionValue(argv, "--cwd")).toBe("/app");
    expect(JSON.parse(optionValue(argv, "--argv-json"))).toEqual(["/bin/sh", "-lc", "echo hello"]);
    expect(JSON.parse(optionValue(argv, "--env-json"))).toEqual({ FOO: "bar" });
    expect(optionValue(argv, "--timeout-ms")).toBe("1234");
  });

  it("returns exec specs that call the embedded HTTP bridge without auth env", async () => {
    stubRequiredAgentBenchEnv({ endpoint: "http://127.0.0.1:19010/v1" });
    vi.stubEnv("OPENAI_API_KEY", "sk-should-not-leak");
    vi.stubEnv("LANG", "C.UTF-8");

    const backend = await createAgentBenchSandboxBackend(createBackendParams());
    const spec = await backend.buildExecSpec({
      command: "python -V",
      workdir: "/app/pkg",
      env: { PYTHONUNBUFFERED: "1" },
      usePty: false,
      timeoutMs: 5000,
    });

    expect(spec.stdinMode).toBe("pipe-closed");
    expect(spec.argv[0]).toBe(process.execPath);
    expect(optionValue(spec.argv, "--cwd")).toBe("/app/pkg");
    expect(JSON.parse(optionValue(spec.argv, "--argv-json"))).toEqual([
      "/bin/sh",
      "-lc",
      "python -V",
    ]);
    expect(JSON.parse(optionValue(spec.argv, "--env-json"))).toEqual({
      PYTHONUNBUFFERED: "1",
      AGENT_BENCH_OPENCLAW_SESSION_KEY: "agent:terminal_bench:session-1",
      AGENT_BENCH_OPENCLAW_SANDBOX_BACKEND: "agent-bench",
      AGENT_BENCH_OPENCLAW_SANDBOX_NAME: "tb-sandbox",
      AGENT_BENCH_OPENCLAW_TOOL_OPERATION: "exec",
    });
    expect(optionValue(spec.argv, "--timeout-ms")).toBe("5000");
    expect(spec.env[AGENT_BENCH_TOOL_BRIDGE_ENDPOINT_ENV]).toBe("http://127.0.0.1:19010/v1/exec");
    expect(spec.env.AGENT_BENCH_TOOL_BRIDGE_TOKEN).toBeUndefined();
    expect(spec.env[AGENT_BENCH_SANDBOX_NAME_ENV]).toBe("tb-sandbox");
    expect(spec.env.LANG).toBe("C.UTF-8");
    expect(spec.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("rejects non-loopback tool bridge endpoints", async () => {
    stubRequiredAgentBenchEnv({ endpoint: "http://tool-bridge:19010" });

    await expect(createAgentBenchSandboxBackend(createBackendParams())).rejects.toThrow(
      "host-loopback 127.0.0.1",
    );
  });

  it.runIf(process.platform !== "win32")(
    "runs remote shell commands through the fake HTTP bridge",
    async () => {
      await withFakeBridgeServer(
        async (request) => {
          expect(request.method).toBe("POST");
          expect(request.url).toBe("/v1/exec");
          expect(request.authorization).toBeUndefined();
          return execResponse(request.body, {
            stdout: Buffer.from(JSON.stringify(request.body)),
            stderr: Buffer.from("bridge stderr"),
          });
        },
        async (endpoint) => {
          stubRequiredAgentBenchEnv({ endpoint });

          const backend = await createAgentBenchSandboxBackend(createBackendParams());
          const result = await backend.runShellCommand({
            script: "printf ok",
            args: ["arg-one"],
            stdin: Buffer.from("input"),
          });

          const payload = JSON.parse(result.stdout.toString("utf8"));
          expect(result.code).toBe(0);
          expect(result.stderr.toString("utf8")).toBe("bridge stderr");
          expect(payload.cwd).toBe("/app");
          expect(payload.argv).toEqual([
            "/bin/sh",
            "-c",
            "printf ok",
            "openclaw-sandbox-fs",
            "arg-one",
          ]);
          expect(payload.env).toMatchObject({
            AGENT_BENCH_OPENCLAW_SESSION_KEY: "agent:terminal_bench:session-1",
            AGENT_BENCH_OPENCLAW_SANDBOX_BACKEND: "agent-bench",
            AGENT_BENCH_OPENCLAW_SANDBOX_NAME: "tb-sandbox",
            AGENT_BENCH_OPENCLAW_TOOL_OPERATION: "fs",
          });
          expect(payload.stdin_b64).toBe(Buffer.from("input").toString("base64"));
          expect(payload.timeout_ms).toBe(300000);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps filesystem write payload on stdin instead of argv",
    async () => {
      const markdown = Buffer.from("# Summary\nRequest completed.\n\n# Checks\n/app exists.\n");
      await withFakeBridgeServer(
        async (request) => {
          expect(request.body.argv).toEqual([
            "/bin/sh",
            "-c",
            "printf helper",
            "openclaw-sandbox-fs",
            "write",
            "/app",
            "",
            "answer.md",
            "1",
          ]);
          expect(request.body.argv.join(" ")).not.toContain("# Summary");
          expect(request.body.stdin_b64).toBe(markdown.toString("base64"));
          return execResponse(request.body);
        },
        async (endpoint) => {
          stubRequiredAgentBenchEnv({ endpoint });

          const backend = await createAgentBenchSandboxBackend(createBackendParams());
          const result = await backend.runShellCommand({
            script: "printf helper",
            args: ["write", "/app", "", "answer.md", "1"],
            stdin: markdown,
          });

          expect(result.code).toBe(0);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "throws on bridge failure unless allowFailure is set",
    async () => {
      await withFakeBridgeServer(
        async (request) =>
          execResponse(request.body, {
            code: 7,
            stderr: Buffer.from("bridge failed"),
          }),
        async (endpoint) => {
          stubRequiredAgentBenchEnv({ endpoint });

          const backend = await createAgentBenchSandboxBackend(createBackendParams());
          await expect(backend.runShellCommand({ script: "fail" })).rejects.toMatchObject({
            code: 7,
            stderr: Buffer.from("bridge failed"),
          });
          await expect(
            backend.runShellCommand({ script: "fail", allowFailure: true }),
          ).resolves.toMatchObject({
            code: 7,
            stderr: Buffer.from("bridge failed"),
          });
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "maps timed-out bridge responses to failed command results",
    async () => {
      await withFakeBridgeServer(
        async (request) => execResponse(request.body, { timedOut: true }),
        async (endpoint) => {
          stubRequiredAgentBenchEnv({ endpoint });

          const backend = await createAgentBenchSandboxBackend(createBackendParams());
          await expect(backend.runShellCommand({ script: "sleep 999" })).rejects.toMatchObject({
            code: 124,
            stderr: Buffer.from("Agent Bench tool bridge command timed out.\n"),
          });
          await expect(
            backend.runShellCommand({ script: "sleep 999", allowFailure: true }),
          ).resolves.toMatchObject({
            code: 124,
            stderr: Buffer.from("Agent Bench tool bridge command timed out.\n"),
          });
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "wires filesystem reads through the same HTTP bridge",
    async () => {
      await withTempDir("openclaw-agent-bench-backend-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        await withFakeBridgeServer(
          async (request) => {
            if (request.body.argv.includes("read")) {
              return execResponse(request.body, { stdout: BINARY_READ_OUTPUT });
            }
            return execResponse(request.body);
          },
          async (endpoint) => {
            stubRequiredAgentBenchEnv({ endpoint });

            const backend = await createAgentBenchSandboxBackend(
              createBackendParams({ workspaceDir, agentWorkspaceDir: workspaceDir }),
            );
            const bridge = backend.createFsBridge?.({
              sandbox: createSandboxTestContext({
                overrides: {
                  workspaceDir,
                  agentWorkspaceDir: workspaceDir,
                  workspaceAccess: "rw",
                  containerWorkdir: "/app",
                },
              }),
            });

            await expect(bridge?.readFile({ filePath: "note.txt" })).resolves.toEqual(
              BINARY_READ_OUTPUT,
            );
          },
        );
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "uses structured tool service filesystem bridge when OpenClaw tool map is configured",
    async () => {
      await withTempDir("openclaw-agent-bench-tool-service-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        const toolMapPath = path.join(stateDir, "openclaw-tool-map.json");
        await fs.writeFile(
          toolMapPath,
          JSON.stringify({
            endpoint: "http://127.0.0.1:19010/v1/tool-call",
            mappings: {
              "openclaw.read.readFile": "openclaw.fs.read_file",
              "openclaw.read.access": "openclaw.fs.stat",
            },
          }),
          "utf8",
        );
        await withFakeToolServiceServer(
          async (request) => {
            expect(request.method).toBe("POST");
            expect(request.url).toBe("/v1/tool-call");
            expect(request.body.canonical_tool).toBe("openclaw.fs.read_file");
            expect(request.body.input).toEqual({ cwd: "/app", path: "note.txt" });
            expect(request.body.metadata).toMatchObject({
              AGENT_BENCH_OPENCLAW_SESSION_KEY: "agent:terminal_bench:session-1",
              AGENT_BENCH_OPENCLAW_TOOL_OPERATION: "openclaw.read.readFile",
              AGENT_BENCH_OPENCLAW_SANDBOX_NAME: "tb-sandbox",
            });
            return toolCallResponse(request.body, {
              output: {
                data_b64: BINARY_READ_OUTPUT.toString("base64"),
                size: BINARY_READ_OUTPUT.length,
              },
            });
          },
          async (endpoint) => {
            stubRequiredAgentBenchEnv({ endpoint });
            vi.stubEnv(AGENT_BENCH_OPENCLAW_TOOL_CONFIG_PATH_ENV, toolMapPath);
            vi.stubEnv(AGENT_BENCH_TOOL_SERVICE_ENDPOINT_ENV, `${endpoint}/v1/tool-call`);

            const backend = await createAgentBenchSandboxBackend(
              createBackendParams({ workspaceDir, agentWorkspaceDir: workspaceDir }),
            );
            const bridge = backend.createFsBridge?.({
              sandbox: createSandboxTestContext({
                overrides: {
                  workspaceDir,
                  agentWorkspaceDir: workspaceDir,
                  workspaceAccess: "rw",
                  containerWorkdir: "/app",
                },
              }),
            });

            await expect(
              bridge?.readFile({ filePath: path.join(workspaceDir, "note.txt") }),
            ).resolves.toEqual(BINARY_READ_OUTPUT);
          },
        );
      });
    },
  );

  it("does not claim ownership of sandbox removal", async () => {
    stubRequiredAgentBenchEnv({ endpoint: "http://127.0.0.1:19010" });

    await expect(
      agentBenchSandboxBackendManager.removeRuntime({
        entry: { image: "tb-sandbox" } as never,
        config: {} as never,
      }),
    ).resolves.toBeUndefined();
    await expect(
      agentBenchSandboxBackendManager.describeRuntime({
        entry: { image: "tb-sandbox" } as never,
        config: {} as never,
      }),
    ).resolves.toMatchObject({
      running: true,
      actualConfigLabel: "tb-sandbox",
      configLabelMatch: true,
    });
  });
});

function optionValue(argv: readonly string[], option: string): string {
  const index = argv.indexOf(option);
  expect(index).toBeGreaterThanOrEqual(0);
  const value = argv[index + 1];
  expect(value).toBeDefined();
  return value as string;
}

function stubRequiredAgentBenchEnv(params: { endpoint: string }): void {
  vi.stubEnv(AGENT_BENCH_TOOL_BRIDGE_ENDPOINT_ENV, params.endpoint);
  vi.stubEnv(AGENT_BENCH_SANDBOX_NAME_ENV, "tb-sandbox");
  vi.stubEnv("AGENT_BENCH_SANDBOX_WORKDIR", "/app");
  vi.stubEnv("AGENT_BENCH_SANDBOX_WORKSPACE_DIR", "/app");
  vi.stubEnv("AGENT_BENCH_SANDBOX_AGENT_WORKSPACE_DIR", "/app");
}

function createBackendParams(
  overrides: Partial<Pick<CreateSandboxBackendParams, "workspaceDir" | "agentWorkspaceDir">> = {},
): CreateSandboxBackendParams {
  return {
    sessionKey: "agent:terminal_bench:session-1",
    scopeKey: "terminal-bench-scope",
    workspaceDir: overrides.workspaceDir ?? "/host/workspace",
    agentWorkspaceDir: overrides.agentWorkspaceDir ?? overrides.workspaceDir ?? "/host/workspace",
    cfg: createSandboxConfig(),
  };
}

function createSandboxConfig(): SandboxConfig {
  return {
    mode: "all",
    backend: "agent-bench",
    scope: "session",
    workspaceAccess: "rw",
    workspaceRoot: "/tmp/openclaw-sandboxes",
    docker: {
      image: "unused-agent-bench-sandbox",
      containerPrefix: "unused-",
      workdir: "/app",
      readOnlyRoot: true,
      tmpfs: [],
      network: "none",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: false,
    },
    browser: {
      enabled: false,
      image: "unused-browser",
      containerPrefix: "unused-browser-",
      network: "none",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      enableNoVnc: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 1,
    },
    tools: { allow: ["*"], deny: [] },
    prune: { idleHours: 0, maxAgeDays: 0 },
  };
}

async function withFakeBridgeServer<T>(
  handler: (request: CapturedBridgeRequest) => Promise<ExecResponseBody> | ExecResponseBody,
  run: (endpoint: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer(async (request, response) => {
    await handleBridgeRequest(request, response, handler);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function withFakeToolServiceServer<T>(
  handler: (
    request: CapturedToolCallRequest,
  ) => Promise<ToolCallResponseBody> | ToolCallResponseBody,
  run: (endpoint: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/tool-call") {
        response.writeHead(404).end("not found");
        return;
      }
      const body = JSON.parse(
        (await readRequestBody(request)).toString("utf8"),
      ) as ToolCallRequestBody;
      const result = await handler({
        method: request.method,
        url: request.url,
        body,
      });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" }).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function handleBridgeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: CapturedBridgeRequest) => Promise<ExecResponseBody> | ExecResponseBody,
): Promise<void> {
  try {
    if (request.method !== "POST" || request.url !== "/v1/exec") {
      response.writeHead(404).end("not found");
      return;
    }
    const body = JSON.parse((await readRequestBody(request)).toString("utf8")) as ExecRequestBody;
    const result = await handler({
      authorization: Array.isArray(request.headers.authorization)
        ? request.headers.authorization[0]
        : request.headers.authorization,
      method: request.method,
      url: request.url,
      body,
    });
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain" }).end(String(error));
  }
}

function toolCallResponse(
  request: ToolCallRequestBody,
  params: {
    ok?: boolean;
    output?: Record<string, unknown>;
    error?: string;
  } = {},
): ToolCallResponseBody {
  return {
    type: "tool_result",
    id: request.id,
    canonical_tool: request.canonical_tool,
    ok: params.ok ?? true,
    output: params.output ?? {},
    ...(params.error ? { error: params.error } : {}),
  };
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function execResponse(
  request: ExecRequestBody,
  params: {
    code?: number;
    stdout?: Buffer;
    stderr?: Buffer;
    timedOut?: boolean;
  } = {},
): ExecResponseBody {
  return {
    type: "exec_result",
    id: request.id,
    exit_code: params.code ?? 0,
    stdout_b64: (params.stdout ?? Buffer.alloc(0)).toString("base64"),
    stderr_b64: (params.stderr ?? Buffer.alloc(0)).toString("base64"),
    timed_out: params.timedOut ?? false,
  };
}

async function withTempDir<T>(prefix: string, run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", prefix));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}
