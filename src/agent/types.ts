export type ApprovalDecision = "accept" | "decline" | "cancel" | "acceptForSession";

export type AgentEvent =
  | {
      type: "turn_started";
      sessionId: string;
      turnId: string;
    }
  | {
      type: "message_delta";
      sessionId: string;
      turnId: string;
      text: string;
    }
  | {
      type: "message_complete";
      sessionId: string;
      turnId: string;
      text: string;
    }
  | {
      type: "approval_required";
      sessionId: string;
      turnId: string;
      approvalId: string;
      kind: "shell" | "file_change" | "network" | "user_input";
      title: string;
      summary: string;
      detailsRef?: string;
      availableDecisions: ApprovalDecision[];
    }
  | {
      type: "diff_updated";
      sessionId: string;
      turnId: string;
      diffRef: string;
      changedFiles: string[];
      stats?: { files: number; additions: number; deletions: number };
    }
  | {
      type: "turn_complete";
      sessionId: string;
      turnId: string;
      status: "completed" | "interrupted" | "failed";
      summary?: string;
      changedFiles?: string[];
      latestDiffRef?: string;
    }
  | {
      type: "error";
      sessionId: string;
      turnId?: string;
      summary: string;
      detailsRef?: string;
    };

export type StartSessionOptions = {
  cwd: string;
  model?: string;
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
};

export type ListAgentSessionsOptions = {
  cwd?: string;
  limit?: number;
  includeMessageCounts?: boolean;
};

export type AgentSession = {
  sessionId: string;
  threadId: string;
  cwd: string;
  model: string;
};

export type AgentSessionSummary = {
  threadId: string;
  cwd: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
};

export type AgentTurn = {
  turnId: string;
};

export type AgentTranscriptMessage = {
  role: "user" | "agent";
  text: string;
};

export interface AgentAdapter {
  startSession(options: StartSessionOptions): Promise<AgentSession>;
  resumeSession(sessionId: string, options?: { cwd?: string }): Promise<AgentSession>;
  listSessions(options?: ListAgentSessionsOptions): Promise<AgentSessionSummary[]>;
  readRecentMessages(
    sessionId: string,
    options?: { limit?: number }
  ): Promise<AgentTranscriptMessage[]>;
  sendMessage(sessionId: string, text: string): Promise<AgentTurn>;
  steerActiveTurn(sessionId: string, turnId: string, text: string): Promise<void>;
  answerApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<void>;
  interrupt(sessionId: string, turnId: string): Promise<void>;
  streamEvents(sessionId?: string): AsyncIterable<AgentEvent>;
}
