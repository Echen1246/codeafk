import { basename } from "node:path";

import type { AgentAdapter, AgentSessionSummary } from "./agent/types.js";
import type { ChannelEvent, MessageChannel } from "./channel/types.js";

const MAX_PROJECTS = 8;
const MAX_SESSIONS = 8;

export type SessionSelection = {
  cwd: string;
  threadId?: string;
};

export type SessionPickerOptions = {
  agent: AgentAdapter;
  channel: MessageChannel;
  events: AsyncIterator<ChannelEvent>;
  defaultCwd: string;
  now?: Date;
  signal?: AbortSignal;
};

export class SessionSelectionAborted extends Error {
  constructor() {
    super("Session selection aborted");
    this.name = "SessionSelectionAborted";
  }
}

export function isSessionSelectionAborted(error: unknown): error is SessionSelectionAborted {
  return error instanceof SessionSelectionAborted;
}

type ProjectOption = {
  cwd: string;
  name: string;
  sessionCount: number;
  updatedAt: number;
};

export async function selectSessionFromChannel(
  options: SessionPickerOptions
): Promise<SessionSelection> {
  await options.channel.send({
    text: `Pager started for ${basename(options.defaultCwd)}.\nSend /sessions to choose a project and Codex session.`,
  });

  await waitForSessionsCommand(options.channel, options.events, options.signal);

  const recentSessions = await options.agent.listSessions({ limit: 50 });
  const project = await selectProject(options, projectOptions(recentSessions, options.defaultCwd));
  const sessions = await options.agent.listSessions({
    cwd: project.cwd,
    limit: MAX_SESSIONS,
    includeMessageCounts: true,
  });

  return selectSession(options, project, sessions);
}

export function channelEventsFromIterator(
  iterator: AsyncIterator<ChannelEvent>
): AsyncIterable<ChannelEvent> {
  return {
    [Symbol.asyncIterator]: () => iterator,
  };
}

function formatProjectList(projects: ProjectOption[]): string {
  return [
    "Recent projects:",
    "",
    ...projects.map(
      (project, index) =>
        `[${index + 1}] ${project.name} - ${project.cwd} (${project.sessionCount} ${pluralize(
          "session",
          project.sessionCount
        )})`
    ),
    "",
    "Reply with a number.",
  ].join("\n");
}

export function formatSessionList(
  project: ProjectOption,
  sessions: AgentSessionSummary[],
  now = new Date()
): string {
  if (sessions.length === 0) {
    return [
      `No recent sessions in ${project.name}.`,
      "",
      'Reply "new" to start a new session.',
    ].join("\n");
  }

  return [
    `Recent sessions in ${project.name}:`,
    "",
    ...sessions.map(
      (session, index) =>
        `[${index + 1}] ${formatSessionTime(session.updatedAt, now)} - "${truncate(
          session.title,
          72
        )}"${formatMessageCount(session.messageCount)}`
    ),
    "",
    'Reply with a number, or "new" for a new session.',
  ].join("\n");
}

export function projectOptions(
  sessions: AgentSessionSummary[],
  defaultCwd: string
): ProjectOption[] {
  const projects = new Map<string, ProjectOption>();

  for (const session of sessions) {
    const existing = projects.get(session.cwd);
    if (existing === undefined) {
      projects.set(session.cwd, {
        cwd: session.cwd,
        name: basename(session.cwd),
        sessionCount: 1,
        updatedAt: session.updatedAt,
      });
      continue;
    }

    existing.sessionCount += 1;
    existing.updatedAt = Math.max(existing.updatedAt, session.updatedAt);
  }

  if (!projects.has(defaultCwd)) {
    projects.set(defaultCwd, {
      cwd: defaultCwd,
      name: basename(defaultCwd),
      sessionCount: 0,
      updatedAt: 0,
    });
  }

  return [...projects.values()]
    .sort((left, right) => {
      if (left.cwd === defaultCwd) {
        return -1;
      }
      if (right.cwd === defaultCwd) {
        return 1;
      }
      return right.updatedAt - left.updatedAt;
    })
    .slice(0, MAX_PROJECTS);
}

export function formatSessionTime(updatedAtSeconds: number, now: Date): string {
  const updatedAt = new Date(updatedAtSeconds * 1000);
  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - updatedAt.getTime()) / 1000));
  const dayDifference = calendarDayDifference(updatedAt, now);

  if (dayDifference === 0) {
    return `today, ${formatElapsed(elapsedSeconds)}`;
  }

  if (dayDifference === 1) {
    return "yesterday";
  }

  return `${dayDifference} days ago`;
}

async function waitForSessionsCommand(
  channel: MessageChannel,
  events: AsyncIterator<ChannelEvent>,
  signal: AbortSignal | undefined
): Promise<void> {
  while (true) {
    const event = await nextMessage(events, signal);
    const text = event.text.trim().toLowerCase();
    if (text === "/sessions") {
      return;
    }

    await channel.send({ text: "Send /sessions to choose a project and Codex session." });
  }
}

async function selectProject(
  options: SessionPickerOptions,
  projects: ProjectOption[]
): Promise<ProjectOption> {
  await options.channel.send({ text: formatProjectList(projects) });

  while (true) {
    const event = await nextMessage(options.events, options.signal);
    const selected = parseSelectionNumber(event.text, projects.length);
    if (selected !== null) {
      return projects[selected];
    }

    await options.channel.send({ text: `Reply with a number from 1 to ${projects.length}.` });
  }
}

async function selectSession(
  options: SessionPickerOptions,
  project: ProjectOption,
  sessions: AgentSessionSummary[]
): Promise<SessionSelection> {
  await options.channel.send({
    text: formatSessionList(project, sessions, options.now ?? new Date()),
  });

  while (true) {
    const event = await nextMessage(options.events, options.signal);
    const text = event.text.trim().toLowerCase();

    if (text === "new") {
      return { cwd: project.cwd };
    }

    const selected = parseSelectionNumber(text, sessions.length);
    if (selected !== null) {
      const session = sessions[selected];
      if (session !== undefined) {
        return { cwd: project.cwd, threadId: session.threadId };
      }
    }

    await options.channel.send({
      text:
        sessions.length === 0
          ? 'Reply "new" to start a new session.'
          : `Reply with a number from 1 to ${sessions.length}, or "new".`,
    });
  }
}

async function nextMessage(
  events: AsyncIterator<ChannelEvent>,
  signal?: AbortSignal
): Promise<Extract<ChannelEvent, { type: "message" }>> {
  while (true) {
    if (signal?.aborted === true) {
      throw new SessionSelectionAborted();
    }

    const event = await Promise.race([events.next(), waitForAbort(signal)]);
    if (event.done === true) {
      throw new Error("Channel closed before session selection completed");
    }

    if (event.value.type === "message") {
      return event.value;
    }
  }
}

function waitForAbort(signal: AbortSignal | undefined): Promise<IteratorResult<ChannelEvent>> {
  if (signal === undefined) {
    return new Promise(() => undefined);
  }

  if (signal.aborted) {
    return Promise.reject(new SessionSelectionAborted());
  }

  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new SessionSelectionAborted()),
      { once: true }
    );
  });
}

function parseSelectionNumber(text: string, optionCount: number): number | null {
  const value = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(value) || String(value) !== text.trim()) {
    return null;
  }

  if (value < 1 || value > optionCount) {
    return null;
  }

  return value - 1;
}

function formatMessageCount(messageCount: number | undefined): string {
  if (messageCount === undefined) {
    return "";
  }

  return ` (${messageCount} msg)`;
}

function formatElapsed(elapsedSeconds: number): string {
  if (elapsedSeconds < 60) {
    return "now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }

  return `${Math.floor(elapsedMinutes / 60)}h`;
}

function calendarDayDifference(earlier: Date, later: Date): number {
  const earlierDay = new Date(earlier.getFullYear(), earlier.getMonth(), earlier.getDate());
  const laterDay = new Date(later.getFullYear(), later.getMonth(), later.getDate());
  return Math.max(0, Math.floor((laterDay.getTime() - earlierDay.getTime()) / 86400000));
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}...`;
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
