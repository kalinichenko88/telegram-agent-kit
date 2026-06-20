export type ChatKey = { chatId: number; agentId: string };

export type Logger = {
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  info?(msg: string, data?: unknown): void;
};

/** Raw Bot API transport primitives — one HTTP call each, NO chunking /
 *  rendering / fallback (the kit owns those). Each throws TelegramApiError
 *  (see ../errors.ts) on a Bot API error. */
export type BotClient = {
  sendMessage(
    p: { chatId: number; text: string; parseMode?: 'HTML' },
    signal?: AbortSignal,
  ): Promise<void>;
  sendRichMessage(
    p: { chatId: number; markdown: string },
    signal?: AbortSignal,
  ): Promise<void>;
  sendPhoto(
    p: { chatId: number; url: string; caption?: string; parseMode?: 'HTML' },
    signal?: AbortSignal,
  ): Promise<void>;
  sendChatAction(
    p: { chatId: number; action?: string },
    signal?: AbortSignal,
  ): Promise<void>;
  sendMessageDraft(
    p: { chatId: number; draftId: number; text: string },
    signal?: AbortSignal,
  ): Promise<void>;
  sendRichMessageDraft(
    p: { chatId: number; draftId: number; markdown: string },
    signal?: AbortSignal,
  ): Promise<void>;
};

export type RenderEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_start'; id: string; name: string; args: unknown }
  | { type: 'tool_end'; id: string; durationMs: number; error?: string }
  | { type: 'error'; message: string };

export type StreamInput = { messages: { role: 'user'; content: string }[] };
export type AgentStreamContext = { threadId: string; signal?: AbortSignal };
export type AgentStream = (
  input: StreamInput,
  context: AgentStreamContext,
) => AsyncIterable<RenderEvent>;

export type Checkpointer = {
  snapshot(threadId: string): Promise<string | null>;
  rollback(threadId: string, checkpointId: string | null): Promise<void>;
};

export type ThreadStore = {
  resolve(key: ChatKey, now: number): Promise<string>;
  touch(key: ChatKey, now: number): Promise<void>;
};
