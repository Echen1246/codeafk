import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  AgentSessionSummary,
  AgentTranscriptMessage,
  AgentTurn,
  ApprovalDecision,
  ListAgentSessionsOptions,
  StartSessionOptions,
} from "./types.js";

const CLIENT_NAME = "agent_pager";
const CLIENT_TITLE = "Agent Pager";
const CLIENT_VERSION = "0.0.0";
const MAX_STDERR_TAIL_CHARS = 4000;
const MACOS_CODEX_APP_PATH = "/Applications/Codex.app/Contents/Resources/codex";
const SUPPORTED_CODEX_CLI_VERSION = "0.130.0-alpha.5";
const DIFF_DIR_MODE = 0o700;
const DIFF_FILE_MODE = 0o600;

type JsonRpcId = number | string;
type JsonObject = Record<string, unknown>;
type CodexProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export type JsonRpcOutboundMessage =
  | { id: JsonRpcId; method: string; params?: unknown }
  | { method: string; params?: unknown }
  | { id: JsonRpcId; result: unknown }
  | { id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

type QueueWaiter<T> = {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: Error) => void;
};

type PendingApprovalResponse = {
  sessionId: string;
  turnId: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

type DiffStats = { files: number; additions: number; deletions: number };

type StoredDiff = {
  diffRef: string;
  changedFiles: string[];
  stats: DiffStats;
  isEmpty: boolean;
};

export class JsonRpcLineParser {
  private buffer = "";

  push(chunk: string): JsonObject[] {
    this.buffer += chunk;
    const messages: JsonObject[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return messages;
      }

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) {
        throw new Error("JSON-RPC line must decode to an object");
      }
      messages.push(parsed);
    }
  }
}

export function encodeJsonRpcMessage(message: JsonRpcOutboundMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseCodexCliVersion(output: string): string | null {
  const match = output.match(/\bcodex-cli\s+([^\s]+)/);
  return match?.[1] ?? null;
}

class JsonRpcResponseError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
    this.name = "JsonRpcResponseError";
  }
}

export class CodexProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexProcessError";
  }
}

export function isCodexProcessError(error: unknown): error is CodexProcessError {
  return error instanceof CodexProcessError;
}

class JsonRpcConnection {
  private readonly parser = new JsonRpcLineParser();
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly onServerRequest: (
      method: string,
      params: unknown,
      requestId: JsonRpcId
    ) => Promise<unknown>
  ) {
    stdout.on("data", (chunk: Buffer) => {
      this.handleChunk(this.decoder.write(chunk));
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;

    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
    });

    const message = params === undefined ? { id, method } : { id, method, params };
    this.writeMessage(message).catch((error: unknown) => {
      const pending = this.pending.get(String(id));
      this.pending.delete(String(id));
      pending?.reject(asError(error));
    });

    return response;
  }

  notify(method: string, params?: unknown): Promise<void> {
    const message = params === undefined ? { method } : { method, params };
    return this.writeMessage(message);
  }

  closeWithError(error: Error): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleChunk(chunk: string): void {
    let messages: JsonObject[];
    try {
      messages = this.parser.push(chunk);
    } catch (error) {
      this.closeWithError(asError(error));
      return;
    }

    for (const message of messages) {
      this.handleMessage(message);
    }
  }

  private handleMessage(message: JsonObject): void {
    const method = message.method;
    const id = getJsonRpcId(message);

    if (typeof method === "string" && id !== null) {
      this.handleServerRequest(id, method, message.params);
      return;
    }

    if (typeof method === "string") {
      this.onNotification(method, message.params);
      return;
    }

    if (id !== null) {
      this.handleResponse(id, message);
    }
  }

  private handleResponse(id: JsonRpcId, message: JsonObject): void {
    const pending = this.pending.get(String(id));
    if (pending === undefined) {
      return;
    }

    this.pending.delete(String(id));

    if (isRecord(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : -32000;
      const text =
        typeof message.error.message === "string" ? message.error.message : "JSON-RPC request failed";
      pending.reject(new JsonRpcResponseError(code, text, message.error.data));
      return;
    }

    pending.resolve(message.result);
  }

  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    this.onServerRequest(method, params, id)
      .then((result) => this.writeMessage({ id, result: result ?? {} }))
      .catch((error: unknown) => {
        const rpcError = error instanceof JsonRpcResponseError ? error : null;
        const responseError =
          rpcError === null
            ? { code: -32603, message: asError(error).message }
            : { code: rpcError.code, message: rpcError.message, data: rpcError.data };
        return this.writeMessage({ id, error: responseError });
      })
      .catch((error: unknown) => {
        this.closeWithError(asError(error));
      });
  }

  private writeMessage(message: JsonRpcOutboundMessage): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Cannot write to a closed JSON-RPC connection"));
    }

    return new Promise((resolve, reject) => {
      this.stdin.write(encodeJsonRpcMessage(message), (error) => {
        if (error === null || error === undefined) {
          resolve();
          return;
        }
        reject(error);
      });
    });
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly items: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];
  private closed = false;
  private failure: Error | null = null;

  push(item: T): void {
    if (this.closed || this.failure !== null) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: item, done: false });
      return;
    }

    this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve({ value: item, done: false });
    }

    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }

    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

type CodexAdapterOptions = {
  codexPath?: string;
  diffDirectory?: string;
  env?: NodeJS.ProcessEnv;
  onWarning?: (message: string) => void;
};

export class CodexAdapter implements AgentAdapter {
  private readonly codexPath: string;
  private readonly diffDirectory: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly onWarning: (message: string) => void;
  private readonly events = new AsyncEventQueue<AgentEvent>();
  private readonly messageBuffers = new Map<string, string>();
  private readonly latestDiffs = new Map<string, StoredDiff>();
  private readonly pendingApprovals = new Map<string, PendingApprovalResponse>();
  private readonly requestApprovals = new Map<string, string>();
  private process: CodexProcess | null = null;
  private connection: JsonRpcConnection | null = null;
  private initialized = false;
  private processFailureHandled = false;
  private stderrTail = "";
  private versionChecked = false;

  constructor(options: CodexAdapterOptions = {}) {
    this.codexPath = options.codexPath ?? defaultCodexPath();
    this.env = options.env ?? process.env;
    this.diffDirectory = options.diffDirectory ?? getDiffDirectory(this.env);
    this.onWarning = options.onWarning ?? ((message) => console.warn(message));
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    await this.ensureInitialized(options.cwd);
    const result = await this.request("thread/start", {
      cwd: options.cwd,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
      serviceName: CLIENT_NAME,
    });

    return sessionFromThreadResponse(result, options.cwd);
  }

  async resumeSession(sessionId: string, options: { cwd?: string } = {}): Promise<AgentSession> {
    const cwd = options.cwd ?? process.cwd();
    await this.ensureInitialized(cwd);
    const result = await this.request("thread/resume", {
      threadId: sessionId,
      cwd,
    });
    return sessionFromThreadResponse(result, cwd);
  }

  async listSessions(options: ListAgentSessionsOptions = {}): Promise<AgentSessionSummary[]> {
    await this.ensureInitialized(options.cwd ?? process.cwd());
    const result = await this.request("thread/list", {
      limit: options.limit ?? 10,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const summaries = sessionSummariesFromThreadListResponse(result);

    if (options.includeMessageCounts !== true) {
      return summaries;
    }

    return Promise.all(summaries.map((summary) => this.withMessageCount(summary)));
  }

  async readRecentMessages(
    sessionId: string,
    options: { limit?: number } = {}
  ): Promise<AgentTranscriptMessage[]> {
    await this.ensureInitialized(process.cwd());
    const result = await this.request("thread/read", {
      threadId: sessionId,
      includeTurns: true,
    });

    return recentMessagesFromThreadReadResponse(result, options.limit ?? 10);
  }

  async sendMessage(sessionId: string, text: string): Promise<AgentTurn> {
    const result = await this.request("turn/start", {
      threadId: sessionId,
      input: [textInput(text)],
    });

    return turnFromStartResponse(result);
  }

  async steerActiveTurn(sessionId: string, turnId: string, text: string): Promise<void> {
    await this.request("turn/steer", {
      threadId: sessionId,
      expectedTurnId: turnId,
      input: [textInput(text)],
    });
  }

  async answerApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    if (decision !== "accept" && decision !== "decline") {
      throw new Error("Only accept and decline approval decisions are implemented in checkpoint 4");
    }

    const pending = this.pendingApprovals.get(approvalId);
    if (pending === undefined) {
      throw new Error("Approval is no longer pending");
    }

    if (pending.sessionId !== sessionId) {
      throw new Error("Approval does not belong to the active session");
    }

    this.pendingApprovals.delete(approvalId);
    pending.resolve({ decision });
  }

  async interrupt(sessionId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId: sessionId, turnId });
  }

  async *streamEvents(sessionId?: string): AsyncIterable<AgentEvent> {
    for await (const event of this.events) {
      if (sessionId === undefined || event.sessionId === sessionId) {
        yield event;
      }
    }
  }

  async dispose(): Promise<void> {
    this.events.close();
    this.connection?.closeWithError(new Error("Codex adapter disposed"));
    this.processFailureHandled = true;

    if (this.process === null || this.process.killed) {
      return;
    }

    this.process.kill("SIGTERM");
  }

  private async ensureInitialized(cwd: string): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.checkCodexVersion(cwd);
    this.startProcess(cwd);

    await this.request("initialize", {
      clientInfo: {
        name: CLIENT_NAME,
        title: CLIENT_TITLE,
        version: CLIENT_VERSION,
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    await this.connection?.notify("initialized");
    this.initialized = true;
  }

  private startProcess(cwd: string): void {
    if (this.process !== null) {
      return;
    }

    this.process = spawn(this.codexPath, ["app-server", "--listen", "stdio://"], {
      cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.connection = new JsonRpcConnection(
      this.process.stdin,
      this.process.stdout,
      (method, params) => this.handleNotification(method, params),
      (method, params, requestId) => this.handleServerRequest(method, params, requestId)
    );
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_TAIL_CHARS);
    });

    this.process.once("error", (error) => {
      this.handleProcessFailure(
        new CodexProcessError(`Codex app-server failed to start: ${error.message}`)
      );
    });
    this.process.once("exit", (code, signal) => {
      const stderr = this.stderrTail.trim();
      const suffix = stderr.length === 0 ? "" : `\n\nCodex stderr:\n${stderr}`;
      this.handleProcessFailure(
        new CodexProcessError(`Codex app-server exited with code ${code} signal ${signal}${suffix}`)
      );
    });
  }

  private async checkCodexVersion(cwd: string): Promise<void> {
    if (this.versionChecked) {
      return;
    }
    this.versionChecked = true;

    try {
      const output = await collectCommandOutput(this.codexPath, ["--version"], cwd, this.env);
      const version = parseCodexCliVersion(output);
      if (version !== null && version !== SUPPORTED_CODEX_CLI_VERSION) {
        this.onWarning(
          `Warning: expected codex-cli ${SUPPORTED_CODEX_CLI_VERSION}, found ${version}. App-server protocol may differ.`
        );
      }
    } catch (error) {
      this.onWarning(`Warning: could not read Codex CLI version: ${asError(error).message}`);
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.connection === null) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }
    return this.connection.request(method, params);
  }

  private async withMessageCount(summary: AgentSessionSummary): Promise<AgentSessionSummary> {
    try {
      const result = await this.request("thread/read", {
        threadId: summary.threadId,
        includeTurns: true,
      });
      return {
        ...summary,
        messageCount: countMessagesInThreadReadResponse(result),
      };
    } catch (error) {
      this.onWarning(
        `Warning: could not read Codex message count for ${summary.threadId}: ${asError(error).message}`
      );
      return summary;
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "turn/started" && isTurnStarted(params)) {
      this.events.push({
        type: "turn_started",
        sessionId: params.threadId,
        turnId: params.turn.id,
      });
      return;
    }

    if (method === "item/agentMessage/delta" && isAgentMessageDelta(params)) {
      const current = this.messageBuffers.get(params.turnId) ?? "";
      this.messageBuffers.set(params.turnId, current + params.delta);
      this.events.push({
        type: "message_delta",
        sessionId: params.threadId,
        turnId: params.turnId,
        text: params.delta,
      });
      return;
    }

    if (method === "item/completed" && isAgentMessageCompleted(params)) {
      this.messageBuffers.set(params.turnId, params.item.text);
      this.events.push({
        type: "message_complete",
        sessionId: params.threadId,
        turnId: params.turnId,
        text: params.item.text,
      });
      return;
    }

    if (method === "turn/completed" && isTurnCompleted(params)) {
      const summary = this.messageBuffers.get(params.turn.id);
      const latestDiff = this.latestDiffs.get(params.turn.id);
      this.latestDiffs.delete(params.turn.id);
      this.events.push({
        type: "turn_complete",
        sessionId: params.threadId,
        turnId: params.turn.id,
        status: params.turn.status,
        ...(summary === undefined ? {} : { summary }),
        ...(latestDiff === undefined || latestDiff.isEmpty
          ? {}
          : {
              changedFiles: latestDiff.changedFiles,
              latestDiffRef: latestDiff.diffRef,
            }),
      });
      return;
    }

    if (method === "turn/diff/updated" && isTurnDiffUpdated(params)) {
      this.handleDiffUpdated(params);
      return;
    }

    if (method === "error" && isErrorNotification(params)) {
      this.events.push({
        type: "error",
        sessionId: params.threadId,
        turnId: params.turnId,
        summary: params.error.message,
        ...(params.error.additionalDetails === null ? {} : { detailsRef: params.error.additionalDetails }),
      });
      return;
    }

    if (method === "serverRequest/resolved" && isServerRequestResolved(params)) {
      const approvalId = this.requestApprovals.get(String(params.requestId));
      if (approvalId !== undefined) {
        this.requestApprovals.delete(String(params.requestId));
        this.pendingApprovals.delete(approvalId);
      }
    }
  }

  private handleServerRequest(
    method: string,
    params: unknown,
    requestId: JsonRpcId
  ): Promise<unknown> {
    if (method === "item/commandExecution/requestApproval" && isCommandApprovalRequest(params)) {
      return this.handleCommandApproval(params, requestId);
    }

    return Promise.reject(
      new JsonRpcResponseError(-32601, `Server request ${method} is not implemented`)
    );
  }

  private handleCommandApproval(
    params: CommandApprovalRequest,
    requestId: JsonRpcId
  ): Promise<unknown> {
    const approvalId = params.approvalId ?? params.itemId;
    const command = params.command ?? "(command unavailable)";
    const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
    const summary = cwd === undefined ? command : `${command}\n\ncwd: ${cwd}`;

    this.requestApprovals.set(String(requestId), approvalId);
    this.events.push({
      type: "approval_required",
      sessionId: params.threadId,
      turnId: params.turnId,
      approvalId,
      kind: "shell",
      title: "Codex needs to run:",
      summary,
      availableDecisions: ["accept", "decline"],
    });

    return new Promise((resolve, reject) => {
      this.pendingApprovals.set(approvalId, {
        sessionId: params.threadId,
        turnId: params.turnId,
        resolve,
        reject,
      });
    });
  }

  private handleDiffUpdated(params: TurnDiffUpdatedNotification): void {
    let storedDiff: StoredDiff;
    try {
      storedDiff = this.snapshotDiff(params.turnId, params.diff);
    } catch (error) {
      this.events.push({
        type: "error",
        sessionId: params.threadId,
        turnId: params.turnId,
        summary: `Failed to snapshot Codex diff: ${asError(error).message}`,
      });
      return;
    }

    this.latestDiffs.set(params.turnId, storedDiff);
    this.events.push({
      type: "diff_updated",
      sessionId: params.threadId,
      turnId: params.turnId,
      diffRef: storedDiff.diffRef,
      changedFiles: storedDiff.changedFiles,
      stats: storedDiff.stats,
    });
  }

  private snapshotDiff(turnId: string, diff: string): StoredDiff {
    mkdirSync(this.diffDirectory, { recursive: true, mode: DIFF_DIR_MODE });

    const diffRef = join(this.diffDirectory, `${safeDiffFilename(turnId)}.diff`);
    writeFileSync(diffRef, diff, { mode: DIFF_FILE_MODE });

    return {
      diffRef,
      ...summarizeUnifiedDiff(diff),
      isEmpty: diff.trim().length === 0,
    };
  }

  private handleProcessFailure(error: Error): void {
    if (this.processFailureHandled) {
      return;
    }
    this.processFailureHandled = true;

    const processError =
      error instanceof CodexProcessError ? error : new CodexProcessError(error.message);

    for (const pending of this.pendingApprovals.values()) {
      pending.reject(processError);
    }
    this.pendingApprovals.clear();
    this.requestApprovals.clear();
    this.connection?.closeWithError(processError);
    this.events.fail(processError);
  }
}

function textInput(text: string): JsonObject {
  return {
    type: "text",
    text,
    text_elements: [],
  };
}

function defaultCodexPath(): string {
  if (existsSync(MACOS_CODEX_APP_PATH)) {
    return MACOS_CODEX_APP_PATH;
  }

  return "codex";
}

export function getDiffDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const xdgStateHome = env.XDG_STATE_HOME;
  const stateHome =
    xdgStateHome !== undefined && xdgStateHome.length > 0
      ? xdgStateHome
      : join(homedir(), ".local", "state");

  return join(stateHome, "apgr", "diffs");
}

export function summarizeUnifiedDiff(diff: string): {
  changedFiles: string[];
  stats: DiffStats;
} {
  const changedFiles = new Set<string>();
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split(/\r?\n/)) {
    const diffPath = parseDiffGitPath(line);
    if (diffPath !== null) {
      changedFiles.add(diffPath);
      continue;
    }

    const headerPath = parseUnifiedDiffHeaderPath(line);
    if (headerPath !== null) {
      changedFiles.add(headerPath);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }

  return {
    changedFiles: [...changedFiles],
    stats: {
      files: changedFiles.size,
      additions,
      deletions,
    },
  };
}

function sessionFromThreadResponse(result: unknown, fallbackCwd: string): AgentSession {
  if (!isRecord(result) || !isRecord(result.thread) || typeof result.thread.id !== "string") {
    throw new Error("Codex app-server returned an invalid thread response");
  }

  return {
    sessionId: result.thread.id,
    threadId: result.thread.id,
    cwd: typeof result.cwd === "string" ? result.cwd : fallbackCwd,
    model: typeof result.model === "string" ? result.model : "unknown",
  };
}

function turnFromStartResponse(result: unknown): AgentTurn {
  if (!isRecord(result) || !isRecord(result.turn) || typeof result.turn.id !== "string") {
    throw new Error("Codex app-server returned an invalid turn response");
  }

  return {
    turnId: result.turn.id,
  };
}

function sessionSummariesFromThreadListResponse(result: unknown): AgentSessionSummary[] {
  if (!isRecord(result) || !Array.isArray(result.data)) {
    throw new Error("Codex app-server returned an invalid thread list response");
  }

  return result.data.flatMap((thread) => {
    if (!isThreadSummary(thread)) {
      return [];
    }

    return [
      {
        threadId: thread.id,
        cwd: thread.cwd,
        title: displayThreadTitle(thread),
        preview: thread.preview,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      },
    ];
  });
}

function countMessagesInThreadReadResponse(result: unknown): number | undefined {
  if (!isRecord(result) || !isRecord(result.thread) || !Array.isArray(result.thread.turns)) {
    return undefined;
  }

  let count = 0;
  for (const turn of result.thread.turns) {
    if (!isRecord(turn) || !Array.isArray(turn.items)) {
      continue;
    }

    for (const item of turn.items) {
      if (isRecord(item) && (item.type === "userMessage" || item.type === "agentMessage")) {
        count += 1;
      }
    }
  }

  return count;
}

function recentMessagesFromThreadReadResponse(
  result: unknown,
  limit: number
): AgentTranscriptMessage[] {
  if (!isRecord(result) || !isRecord(result.thread) || !Array.isArray(result.thread.turns)) {
    throw new Error("Codex app-server returned an invalid thread read response");
  }

  const messages: AgentTranscriptMessage[] = [];
  for (const turn of result.thread.turns) {
    if (!isRecord(turn) || !Array.isArray(turn.items)) {
      continue;
    }

    for (const item of turn.items) {
      const transcriptMessage = transcriptMessageFromThreadItem(item);
      if (transcriptMessage !== null) {
        messages.push(transcriptMessage);
      }
    }
  }

  return messages.slice(-safeMessageLimit(limit));
}

function transcriptMessageFromThreadItem(item: unknown): AgentTranscriptMessage | null {
  if (!isRecord(item)) {
    return null;
  }

  if (item.type === "userMessage" && Array.isArray(item.content)) {
    const text = item.content
      .flatMap((contentItem) =>
        isTextUserInput(contentItem) && contentItem.text.trim().length > 0
          ? [contentItem.text.trim()]
          : []
      )
      .join("\n\n");

    return text.length === 0 ? null : { role: "user", text };
  }

  if (item.type === "agentMessage" && typeof item.text === "string") {
    const text = item.text.trim();
    return text.length === 0 ? null : { role: "agent", text };
  }

  return null;
}

function safeMessageLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 10;
  }

  return Math.max(0, Math.floor(limit));
}

function displayThreadTitle(thread: {
  name: string | null;
  preview: string;
  id: string;
}): string {
  const title = thread.name ?? firstLine(thread.preview);
  return title.length === 0 ? thread.id : title;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? "";
}

function isTurnStarted(value: unknown): value is {
  threadId: string;
  turn: { id: string };
} {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    isRecord(value.turn) &&
    typeof value.turn.id === "string"
  );
}

function isThreadSummary(value: unknown): value is {
  id: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  name: string | null;
} {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.preview === "string" &&
    typeof value.cwd === "string" &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number" &&
    (typeof value.name === "string" || value.name === null)
  );
}

function isTextUserInput(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isAgentMessageDelta(value: unknown): value is {
  threadId: string;
  turnId: string;
  delta: string;
} {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    typeof value.turnId === "string" &&
    typeof value.delta === "string"
  );
}

function isAgentMessageCompleted(value: unknown): value is {
  threadId: string;
  turnId: string;
  item: { type: "agentMessage"; text: string };
} {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    typeof value.turnId === "string" &&
    isRecord(value.item) &&
    value.item.type === "agentMessage" &&
    typeof value.item.text === "string"
  );
}

function isTurnCompleted(value: unknown): value is {
  threadId: string;
  turn: { id: string; status: "completed" | "interrupted" | "failed" };
} {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    isRecord(value.turn) &&
    typeof value.turn.id === "string" &&
    (value.turn.status === "completed" ||
      value.turn.status === "interrupted" ||
      value.turn.status === "failed")
  );
}

type TurnDiffUpdatedNotification = {
  threadId: string;
  turnId: string;
  diff: string;
};

function isTurnDiffUpdated(value: unknown): value is TurnDiffUpdatedNotification {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    typeof value.turnId === "string" &&
    typeof value.diff === "string"
  );
}

function isErrorNotification(value: unknown): value is {
  threadId: string;
  turnId: string;
  error: { message: string; additionalDetails: string | null };
} {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    typeof value.turnId === "string" &&
    isRecord(value.error) &&
    typeof value.error.message === "string" &&
    (typeof value.error.additionalDetails === "string" || value.error.additionalDetails === null)
  );
}

type CommandApprovalRequest = {
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  command?: string | null;
  cwd?: unknown;
};

function isCommandApprovalRequest(value: unknown): value is CommandApprovalRequest {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    typeof value.turnId === "string" &&
    typeof value.itemId === "string" &&
    (value.approvalId === undefined ||
      value.approvalId === null ||
      typeof value.approvalId === "string") &&
    (value.command === undefined || value.command === null || typeof value.command === "string")
  );
}

function isServerRequestResolved(value: unknown): value is { requestId: JsonRpcId } {
  return isRecord(value) && getJsonRpcId({ id: value.requestId }) !== null;
}

function getJsonRpcId(message: JsonObject): JsonRpcId | null {
  const id = message.id;
  if (typeof id === "number" || typeof id === "string") {
    return id;
  }
  return null;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDiffGitPath(line: string): string | null {
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  return match?.[2] ?? null;
}

function parseUnifiedDiffHeaderPath(line: string): string | null {
  if (!line.startsWith("+++ ")) {
    return null;
  }

  const path = line.slice(4).trim().split("\t")[0];
  if (path === "/dev/null") {
    return null;
  }

  if (path.startsWith("a/") || path.startsWith("b/")) {
    return path.slice(2);
  }

  return path.length === 0 ? null : path;
}

function safeDiffFilename(turnId: string): string {
  return turnId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function collectCommandOutput(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}
