export type ChannelMessage = {
  text: string;
  attachments?: Array<{ filename: string; content: Buffer; mimeType: string }>;
  buttons?: Array<{ label: string; callbackId: string }>;
};

export type ChannelEvent =
  | { type: "message"; text: string; fromUserId: string }
  | { type: "button_press"; callbackId: string; fromUserId: string };

export interface MessageChannel {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: ChannelMessage): Promise<void>;
  events(): AsyncIterable<ChannelEvent>;
}
