import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SandboxFsBridge, SandboxFsStat, SandboxResolvedPath } from "./fs-bridge.types.js";
import {
  isPathInsideContainerRoot,
  normalizeContainerPath,
  relativePathEscapesContainerRoot,
} from "./path-utils.js";

type AgentBenchToolMap = {
  endpoint: string;
  mappings: Record<string, string>;
};

export type AgentBenchToolServiceRuntime = {
  endpoint: string;
  mappings: Record<string, string>;
  sandboxName: string;
  sessionKey: string;
  runMetadata: Record<string, string>;
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
};

type AgentBenchToolCallResult = {
  type?: unknown;
  id?: unknown;
  canonical_tool?: unknown;
  ok?: unknown;
  output?: unknown;
  error?: unknown;
};

type MountInfo = {
  localRoot: string;
  containerRoot: string;
  writable: boolean;
};

type ResolvedTarget = SandboxResolvedPath & {
  writable: boolean;
};

export function createAgentBenchToolServiceFsBridge(params: {
  sandbox: {
    workspaceDir: string;
    agentWorkspaceDir: string;
    workspaceAccess: "none" | "ro" | "rw";
  };
  runtime: AgentBenchToolServiceRuntime;
}): SandboxFsBridge {
  return new AgentBenchToolServiceFsBridge(params.sandbox, params.runtime);
}

export function normalizeAgentBenchToolServiceEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new Error(`Agent Bench tool service endpoint must be a valid URL: ${String(error)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Agent Bench tool service endpoint must use http:// or https://.");
  }
  if (url.hostname !== "127.0.0.1") {
    throw new Error("Agent Bench tool service endpoint must use host-loopback 127.0.0.1.");
  }
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (!normalizedPath || normalizedPath === "/") {
    url.pathname = "/v1/tool-call";
  } else if (normalizedPath === "/v1") {
    url.pathname = "/v1/tool-call";
  } else if (normalizedPath !== "/v1/tool-call") {
    throw new Error("Agent Bench tool service endpoint path must be /, /v1, or /v1/tool-call.");
  }
  return url.toString();
}

export function parseAgentBenchToolMap(value: unknown): AgentBenchToolMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent Bench OpenClaw tool map must be an object.");
  }
  const record = value as Record<string, unknown>;
  const endpointRaw = record.endpoint;
  if (typeof endpointRaw !== "string" || !endpointRaw.trim()) {
    throw new Error("Agent Bench OpenClaw tool map requires endpoint.");
  }
  const mappingsRaw = record.mappings;
  if (!mappingsRaw || typeof mappingsRaw !== "object" || Array.isArray(mappingsRaw)) {
    throw new Error("Agent Bench OpenClaw tool map requires mappings.");
  }
  const mappings: Record<string, string> = {};
  for (const [key, target] of Object.entries(mappingsRaw)) {
    if (typeof target !== "string" || !target.trim()) {
      throw new Error(`Agent Bench OpenClaw tool map entry must be a string: ${key}`);
    }
    mappings[key] = target.trim();
  }
  return {
    endpoint: normalizeAgentBenchToolServiceEndpoint(endpointRaw),
    mappings,
  };
}

class AgentBenchToolServiceFsBridge implements SandboxFsBridge {
  constructor(
    private readonly sandbox: {
      workspaceDir: string;
      agentWorkspaceDir: string;
      workspaceAccess: "none" | "ro" | "rw";
    },
    private readonly runtime: AgentBenchToolServiceRuntime,
  ) {}

  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    const target = this.resolveTarget(params);
    return {
      relativePath: target.relativePath,
      containerPath: target.containerPath,
    };
  }

  async readFile(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<Buffer> {
    const target = this.resolveTarget(params);
    const output = await this.call(
      "openclaw.read.readFile",
      {
        cwd: path.posix.dirname(target.containerPath),
        path: path.posix.basename(target.containerPath),
      },
      params.signal,
    );
    const data = requireString(output, "data_b64");
    return Buffer.from(data, "base64");
  }

  async writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const target = this.resolveTarget(params);
    this.ensureWritable(target, "write files");
    if (params.mkdir !== false) {
      await this.mkdirp({
        filePath: path.posix.dirname(target.containerPath),
        signal: params.signal,
      });
    }
    const buffer = Buffer.isBuffer(params.data)
      ? params.data
      : Buffer.from(params.data, params.encoding ?? "utf8");
    await this.call(
      "openclaw.write.writeFile",
      {
        cwd: path.posix.dirname(target.containerPath),
        path: path.posix.basename(target.containerPath),
        data_b64: buffer.toString("base64"),
      },
      params.signal,
    );
  }

  async mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void> {
    const target = this.resolveTarget(params);
    this.ensureWritable(target, "create directories");
    await this.call(
      "openclaw.write.mkdir",
      {
        cwd: path.posix.dirname(target.containerPath),
        path: path.posix.basename(target.containerPath),
      },
      params.signal,
    );
  }

  async remove(params: {
    filePath: string;
    cwd?: string;
    recursive?: boolean;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const target = this.resolveTarget(params);
    this.ensureWritable(target, "remove files");
    await this.call(
      "openclaw.apply_patch.remove",
      {
        cwd: path.posix.dirname(target.containerPath),
        path: path.posix.basename(target.containerPath),
        recursive: params.recursive === true,
        force: params.force !== false,
      },
      params.signal,
    );
  }

  async rename(params: {
    from: string;
    to: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const from = this.resolveTarget({ filePath: params.from, cwd: params.cwd });
    const to = this.resolveTarget({ filePath: params.to, cwd: params.cwd });
    this.ensureWritable(from, "rename files");
    this.ensureWritable(to, "rename files");
    await this.call(
      "openclaw.fs.rename",
      {
        cwd: path.posix.dirname(from.containerPath),
        from_path: path.posix.basename(from.containerPath),
        to_path: to.containerPath,
      },
      params.signal,
    );
  }

  async stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    const target = this.resolveTarget(params);
    const output = await this.call(
      "openclaw.read.access",
      {
        cwd: path.posix.dirname(target.containerPath),
        path: path.posix.basename(target.containerPath),
      },
      params.signal,
    );
    if (output.exists === false) {
      return null;
    }
    return {
      type: normalizeStatType(output.type),
      size: requireNumber(output, "size"),
      mtimeMs: requireNumber(output, "mtime_ms"),
    };
  }

  private async call(
    openclawOperation: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const canonicalTool = this.runtime.mappings[openclawOperation];
    if (!canonicalTool) {
      throw new Error(`Agent Bench OpenClaw tool map is missing ${openclawOperation}.`);
    }
    const id = randomUUID();
    const response = await fetch(this.runtime.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "tool_call",
        id,
        canonical_tool: canonicalTool,
        input,
        metadata: {
          ...this.runtime.runMetadata,
          AGENT_BENCH_OPENCLAW_SESSION_KEY: this.runtime.sessionKey,
          AGENT_BENCH_OPENCLAW_SANDBOX_BACKEND: "agent-bench",
          AGENT_BENCH_OPENCLAW_SANDBOX_NAME: this.runtime.sandboxName,
          AGENT_BENCH_OPENCLAW_TOOL_OPERATION: openclawOperation,
        },
      }),
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Agent Bench tool service request failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const parsed = (await response.json()) as AgentBenchToolCallResult;
    if (
      parsed.type !== "tool_result" ||
      parsed.id !== id ||
      parsed.canonical_tool !== canonicalTool
    ) {
      throw new Error("Agent Bench tool service returned an invalid response envelope.");
    }
    if (parsed.ok !== true) {
      throw new Error(
        typeof parsed.error === "string" ? parsed.error : "Agent Bench tool service call failed.",
      );
    }
    if (!parsed.output || typeof parsed.output !== "object" || Array.isArray(parsed.output)) {
      throw new Error("Agent Bench tool service returned invalid output.");
    }
    return parsed.output as Record<string, unknown>;
  }

  private resolveTarget(params: { filePath: string; cwd?: string }): ResolvedTarget {
    const input = params.filePath.trim();
    if (!input) {
      throw new Error("Sandbox path must be a non-empty string.");
    }
    const inputPosix = input.replace(/\\/g, "/");
    const mounts = this.getMounts();
    if (path.posix.isAbsolute(inputPosix)) {
      const byContainer = this.resolveMountByContainerPath(
        mounts,
        normalizeContainerPath(inputPosix),
      );
      if (byContainer) {
        return this.toResolvedPath(byContainer, normalizeContainerPath(inputPosix));
      }
      const byLocal = this.resolveMountByLocalPath(mounts, path.resolve(input));
      if (byLocal) {
        const relative = toPosixRelative(byLocal.localRoot, path.resolve(input));
        return this.toResolvedPath(
          byLocal,
          relative ? path.posix.join(byLocal.containerRoot, relative) : byLocal.containerRoot,
        );
      }
    }

    const cwdContainer = this.resolveCwdContainerPath(params.cwd, mounts);
    const containerPath = normalizeContainerPath(path.posix.resolve(cwdContainer, inputPosix));
    const mount = this.resolveMountByContainerPath(mounts, containerPath);
    if (!mount) {
      throw new Error(`Sandbox path escapes allowed mounts; cannot access: ${params.filePath}`);
    }
    return this.toResolvedPath(mount, containerPath);
  }

  private resolveCwdContainerPath(cwd: string | undefined, mounts: MountInfo[]): string {
    if (!cwd) {
      return normalizeContainerPath(this.runtime.remoteWorkspaceDir);
    }
    const cwdPosix = cwd.replace(/\\/g, "/");
    if (path.posix.isAbsolute(cwdPosix)) {
      const byContainer = this.resolveMountByContainerPath(
        mounts,
        normalizeContainerPath(cwdPosix),
      );
      if (byContainer) {
        return normalizeContainerPath(cwdPosix);
      }
    }
    const byLocal = this.resolveMountByLocalPath(mounts, path.resolve(cwd));
    if (byLocal) {
      const relative = toPosixRelative(byLocal.localRoot, path.resolve(cwd));
      return relative ? path.posix.join(byLocal.containerRoot, relative) : byLocal.containerRoot;
    }
    throw new Error(`Sandbox cwd escapes allowed mounts; cannot access: ${cwd}`);
  }

  private getMounts(): MountInfo[] {
    const workspaceRoot = path.resolve(this.sandbox.workspaceDir);
    const agentRoot = path.resolve(this.sandbox.agentWorkspaceDir);
    const mounts: MountInfo[] = [
      {
        localRoot: workspaceRoot,
        containerRoot: normalizeContainerPath(this.runtime.remoteWorkspaceDir),
        writable: this.sandbox.workspaceAccess === "rw",
      },
    ];
    if (agentRoot !== workspaceRoot && this.sandbox.workspaceAccess !== "none") {
      mounts.push({
        localRoot: agentRoot,
        containerRoot: normalizeContainerPath(this.runtime.remoteAgentWorkspaceDir),
        writable: this.sandbox.workspaceAccess === "rw",
      });
    }
    return mounts;
  }

  private resolveMountByContainerPath(
    mounts: MountInfo[],
    containerPath: string,
  ): MountInfo | null {
    for (const mount of mounts.toSorted(
      (a, b) => b.containerRoot.length - a.containerRoot.length,
    )) {
      if (isPathInsideContainerRoot(mount.containerRoot, containerPath)) {
        return mount;
      }
    }
    return null;
  }

  private resolveMountByLocalPath(mounts: MountInfo[], localPath: string): MountInfo | null {
    for (const mount of mounts.toSorted((a, b) => b.localRoot.length - a.localRoot.length)) {
      const relative = path.relative(mount.localRoot, localPath);
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        return mount;
      }
    }
    return null;
  }

  private toResolvedPath(mount: MountInfo, containerPath: string): ResolvedTarget {
    const relative = path.posix.relative(mount.containerRoot, containerPath);
    if (relativePathEscapesContainerRoot(relative)) {
      throw new Error(`Sandbox path escapes allowed mounts; cannot access: ${containerPath}`);
    }
    return {
      relativePath: relative === "." ? "" : relative,
      containerPath,
      writable: mount.writable,
    };
  }

  private ensureWritable(target: ResolvedTarget, action: string): void {
    if (!target.writable) {
      throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
    }
  }
}

function toPosixRelative(root: string, target: string): string {
  return path.relative(path.resolve(root), path.resolve(target)).split(path.sep).join("/");
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Agent Bench tool service output requires string ${key}.`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Agent Bench tool service output requires number ${key}.`);
  }
  return value;
}

function normalizeStatType(value: unknown): SandboxFsStat["type"] {
  return value === "file" || value === "directory" || value === "other" ? value : "other";
}
