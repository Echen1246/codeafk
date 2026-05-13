import type { AgentAdapter, AgentEvent, AgentSession } from "./agent/types.js";
import { ApprovalRegistry } from "./approval.js";
import type { ChannelEvent, MessageChannel } from "./channel/types.js";

const CHECKPOINT_THREE_BUSY_MESSAGE =
  "Codex is still working on the previous message. Wait for it to finish, then send the next instruction.";

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

  await Promise.race([
    Promise.all([
      forwardChannelEvents(options, approvals, () => activeTurn, (value) => {
        activeTurn = value;
      }),
      forwardAgentEvents(options, approvals, () => {
        activeTurn = false;
      }),
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
  markTurnComplete: () => void
): Promise<void> {
  for await (const event of options.agent.streamEvents(options.session.sessionId)) {
    if (isAborted(options.signal)) {
      return;
    }

    await handleAgentEvent(options.channel, approvals, event, markTurnComplete);
  }
}

async function handleAgentEvent(
  channel: MessageChannel,
  approvals: ApprovalRegistry,
  event: AgentEvent,
  markTurnComplete: () => void
): Promise<void> {
  if (event.type === "message_complete" && event.text.trim().length > 0) {
    await channel.send({ text: event.text });
    return;
  }

  if (event.type === "turn_complete") {
    markTurnComplete();
    await channel.send({ text: formatTurnComplete(event) });
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

function formatTurnComplete(event: Extract<AgentEvent, { type: "turn_complete" }>): string {
  if (event.status === "completed") {
    return "Codex finished.";
  }

  return `Codex turn ${event.status}.`;
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
