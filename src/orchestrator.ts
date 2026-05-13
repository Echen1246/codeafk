import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { AgentAdapter, AgentEvent, AgentSession } from "./agent/types.js";
import { ApprovalRegistry } from "./approval.js";
import type { ChannelEvent, ChannelMessage, MessageChannel } from "./channel/types.js";

const CHECKPOINT_THREE_BUSY_MESSAGE =
  "Codex is still working on the previous message. Wait for it to finish, then send the next instruction.";
const DIFF_ATTACHMENT_MIME_TYPE = "text/x-diff";

export type OrchestratorOptions = {
  agent: AgentAdapter;
  channel: MessageChannel;
  session: AgentSession;
  approvals?: ApprovalRegistry;
  signal?: AbortSignal;
};

export async function runOrchestrator(options: OrchestratorOptions): Promise<void> {
  let activeTurn = false;
  const approvals = options.approvals ?? new ApprovalRegistry();
  const latestDiffs = new Map<string, LatestDiff>();

  await Promise.race([
    Promise.all([
      forwardChannelEvents(options, approvals, () => activeTurn, (value) => {
        activeTurn = value;
      }),
      forwardAgentEvents(
        options,
        approvals,
        () => {
          activeTurn = false;
        },
        latestDiffs
      ),
    ]),
    waitForAbort(options.signal),
  ]);
}

async function forwardChannelEvents(
  options: OrchestratorOptions,
  approvals: ApprovalRegistry,
  isTurnActive: () => boolean,
  setTurnActive: (value: boolean) => void
): Promise<void> {
  for await (const event of options.channel.events()) {
    if (isAborted(options.signal)) {
      return;
    }

    if (event.type === "message") {
      await handleChannelMessage(options, event, isTurnActive, setTurnActive);
      continue;
    }

    if (event.type === "button_press") {
      await handleButtonPress(options, approvals, event);
    }
  }
}

async function handleChannelMessage(
  options: OrchestratorOptions,
  event: Extract<ChannelEvent, { type: "message" }>,
  isTurnActive: () => boolean,
  setTurnActive: (value: boolean) => void
): Promise<void> {
  const text = event.text.trim();
  if (text.length === 0) {
    return;
  }

  if (isTurnActive()) {
    await options.channel.send({ text: CHECKPOINT_THREE_BUSY_MESSAGE });
    return;
  }

  setTurnActive(true);
  await options.agent.sendMessage(options.session.sessionId, text);
  await options.channel.send({ text: "Sent to Codex." });
}

async function handleButtonPress(
  options: OrchestratorOptions,
  approvals: ApprovalRegistry,
  event: Extract<ChannelEvent, { type: "button_press" }>
): Promise<void> {
  const resolved = approvals.resolveCallback(event.callbackId);
  if (resolved === null) {
    await options.channel.send({ text: "This approval is no longer pending." });
    return;
  }

  await options.agent.answerApproval(
    resolved.approval.sessionId,
    resolved.approval.approvalId,
    resolved.decision
  );
  await options.channel.send({
    text: resolved.decision === "accept" ? "Approved." : "Denied.",
  });
}

async function forwardAgentEvents(
  options: OrchestratorOptions,
  approvals: ApprovalRegistry,
  markTurnComplete: () => void,
  latestDiffs: Map<string, LatestDiff>
): Promise<void> {
  for await (const event of options.agent.streamEvents(options.session.sessionId)) {
    if (isAborted(options.signal)) {
      return;
    }

    await handleAgentEvent(options.channel, approvals, event, markTurnComplete, latestDiffs);
  }
}

async function handleAgentEvent(
  channel: MessageChannel,
  approvals: ApprovalRegistry,
  event: AgentEvent,
  markTurnComplete: () => void,
  latestDiffs: Map<string, LatestDiff>
): Promise<void> {
  if (event.type === "message_complete" && event.text.trim().length > 0) {
    await channel.send({ text: event.text });
    return;
  }

  if (event.type === "diff_updated") {
    latestDiffs.set(event.turnId, event);
    return;
  }

  if (event.type === "turn_complete") {
    markTurnComplete();
    const latestDiff = latestDiffs.get(event.turnId) ?? diffFromTurnComplete(event);
    latestDiffs.delete(event.turnId);
    await channel.send(await formatTurnComplete(event, latestDiff));
    return;
  }

  if (event.type === "approval_required") {
    await channel.send({
      text: formatApproval(event),
      buttons: approvals.register(event),
    });
    return;
  }

  if (event.type === "error") {
    markTurnComplete();
    await channel.send({ text: `Codex error: ${event.summary}` });
  }
}

function formatApproval(event: Extract<AgentEvent, { type: "approval_required" }>): string {
  return `${event.title}\n${event.summary}`;
}

async function formatTurnComplete(
  event: Extract<AgentEvent, { type: "turn_complete" }>,
  latestDiff: LatestDiff | undefined
): Promise<ChannelMessage> {
  const text = formatTurnCompleteText(event, latestDiff);
  const attachment = await readDiffAttachment(event.turnId, latestDiff);

  if (attachment.warning !== undefined) {
    return { text: `${text}\n\n${attachment.warning}` };
  }

  if (attachment.file === undefined) {
    return { text };
  }

  return {
    text,
    attachments: [attachment.file],
  };
}

function formatTurnCompleteText(
  event: Extract<AgentEvent, { type: "turn_complete" }>,
  latestDiff: LatestDiff | undefined
): string {
  const statusText =
    event.status === "completed" ? "Codex finished." : `Codex turn ${event.status}.`;
  const changeText = formatChangeSummary(latestDiff);

  return changeText === null ? statusText : `${statusText}\nChanged: ${changeText}`;
}

function formatChangeSummary(latestDiff: LatestDiff | undefined): string | null {
  if (latestDiff === undefined) {
    return null;
  }

  const stats = latestDiff.stats;
  const statText =
    stats === undefined
      ? null
      : `${stats.files} ${pluralize("file", stats.files)} (+${stats.additions} -${stats.deletions})`;

  if (latestDiff.changedFiles.length === 0 && (stats === undefined || stats.files === 0)) {
    return null;
  }

  if (latestDiff.changedFiles.length === 0) {
    return statText;
  }

  if (latestDiff.changedFiles.length === 1) {
    return stats === undefined
      ? latestDiff.changedFiles[0]
      : `${latestDiff.changedFiles[0]} (+${stats.additions} -${stats.deletions})`;
  }

  return `${statText ?? `${latestDiff.changedFiles.length} files`}\n${latestDiff.changedFiles
    .map((file) => `- ${file}`)
    .join("\n")}`;
}

async function readDiffAttachment(
  turnId: string,
  latestDiff: LatestDiff | undefined
): Promise<{
  file?: NonNullable<ChannelMessage["attachments"]>[number];
  warning?: string;
}> {
  if (latestDiff?.diffRef === undefined) {
    return {};
  }

  let content: Buffer;
  try {
    content = await readFile(latestDiff.diffRef);
  } catch (error) {
    return {
      warning: `Diff attachment unavailable: ${asError(error).message}`,
    };
  }

  if (content.toString("utf8").trim().length === 0) {
    return {};
  }

  return {
    file: {
      filename: `${safeAttachmentName(turnId)}.diff`,
      content,
      mimeType: DIFF_ATTACHMENT_MIME_TYPE,
    },
  };
}

function diffFromTurnComplete(
  event: Extract<AgentEvent, { type: "turn_complete" }>
): LatestDiff | undefined {
  if (event.changedFiles === undefined && event.latestDiffRef === undefined) {
    return undefined;
  }

  return {
    turnId: event.turnId,
    diffRef: event.latestDiffRef,
    changedFiles: event.changedFiles ?? [],
  };
}

type LatestDiff = {
  turnId: string;
  diffRef?: string;
  changedFiles: string[];
  stats?: { files: number; additions: number; deletions: number };
};

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function safeAttachmentName(turnId: string): string {
  const filename = basename(turnId).replace(/[^A-Za-z0-9._-]/g, "_");
  return filename.length === 0 ? "codex-diff" : filename;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    return new Promise(() => undefined);
  }

  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}
