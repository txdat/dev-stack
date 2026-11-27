// The parts of the OpenCode V2 plugin API this plugin uses, declared structurally instead of
// imported: OpenCode loads the built plugin from `dist/dev/opencode`, so the package stays out of
// this checkout. The names and shapes follow `@opencode/plugin` 2.4.x.

/** One text block in a message or system prompt. */
export type TextPart = {
  type: "text";
  text: string;
  metadata?: Record<string, unknown>;
};

/** Any content block a message may carry; only text is read. */
export type ContentPart = { type?: string; text?: unknown; [key: string]: unknown };

/** A stored session message, as `session.context` returns it. */
export type SessionMessage = {
  id?: string;
  type?: string;
  text?: string;
  role?: string;
  content?: string | readonly ContentPart[];
};

/** A skill definition registered with `ctx.skill.transform`. */
export type SkillInfo = {
  id: string;
  name: string;
  description?: string;
  autoinvoke?: boolean;
  path: string;
  content: string;
};

export type SkillEditor = {
  list(): readonly SkillInfo[];
  get(id: string): SkillInfo | undefined;
  add(skill: SkillInfo): void;
  update(id: string, update: (skill: SkillInfo) => void): void;
  remove(id: string): void;
};

/** The prompt a command receives: its arguments, attachments, and selected skills. */
export type Prompt = {
  text: string;
  files?: readonly unknown[];
  agents?: readonly unknown[];
  skills?: readonly { id: string }[];
};

export type CommandInvocation = {
  sessionID: string;
  prompt: Prompt;
  delivery: "steer" | "queue";
};

export type CommandDefinition = {
  name: string;
  description?: string;
  execute: (input: CommandInvocation) => Promise<void>;
};

export type CommandEditor = {
  add(definition: CommandDefinition): void;
};

/** The directory where a session runs. */
export type SessionInfo = {
  location: { directory: string };
};

/** The prompt-admission draft a `prompt` hook may edit. */
export type SessionPromptHook = {
  sessionID: string;
  messageID: string;
  prompt: Prompt;
  metadata?: Record<string, unknown>;
  delivery: "steer" | "queue";
};

/** The system prompt and messages of one model request. */
export type SessionContextHook = {
  sessionID: string;
  agent: string;
  model: { providerID: string; id: string };
  system: TextPart[];
  messages: readonly SessionMessage[];
  options: Record<string, unknown>;
  tools: Record<string, { description: string; input: unknown }>;
};

export type ToolResultContent =
  | TextPart
  | { type: "file"; uri: string; mime: string; name?: string };

export type ToolResult = {
  content?: string | readonly ToolResultContent[];
  metadata?: Record<string, unknown>;
};

export type ToolError = {
  type?: string;
  message: string;
  status?: number;
};

/** One tool call before it runs; `input` is the tool's own arguments. */
export type ToolHookBefore = {
  tool: string;
  input: unknown;
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  codemode: boolean;
};

/** One tool call after it ran or failed. */
export type ToolHookAfter = {
  tool: string;
  input: unknown;
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  codemode: boolean;
} & ({ status: "completed"; result: ToolResult } | { status: "error"; error: ToolError });

export type Registration = {
  dispose(): Promise<void>;
};

/** The OpenCode plugin context, as far as this plugin reads it. */
export type OpenCodeContext = {
  readonly location: { directory: string };
  readonly options: Record<string, unknown>;
  readonly skill: {
    transform(callback: (editor: SkillEditor) => void): Promise<Registration>;
    reload(): Promise<void>;
  };
  readonly command: {
    transform(callback: (editor: CommandEditor) => void): Promise<Registration>;
    reload(): Promise<void>;
  };
  readonly session: {
    get(input: { sessionID: string }): Promise<SessionInfo>;
    context(input: { sessionID: string }): Promise<readonly SessionMessage[]>;
    prompt(input: {
      sessionID: string;
      text: string;
      skills?: readonly { id: string }[];
      metadata?: Record<string, unknown>;
      delivery?: "steer" | "queue";
    }): Promise<unknown>;
    synthetic(input: {
      sessionID: string;
      text: string;
      description?: string;
      delivery?: "steer" | "queue";
      resume?: boolean;
    }): Promise<unknown>;
    wait(input: { sessionID: string }): Promise<void>;
    hook(
      name: "context",
      callback: (event: SessionContextHook) => void | Promise<void>,
    ): Promise<Registration>;
    hook(
      name: "prompt",
      callback: (event: SessionPromptHook) => void | Promise<void>,
    ): Promise<Registration>;
  };
  readonly tool: {
    hook(
      name: "execute.before",
      callback: (event: ToolHookBefore) => void | Promise<void>,
    ): Promise<Registration>;
    hook(
      name: "execute.after",
      callback: (event: ToolHookAfter) => void | Promise<void>,
    ): Promise<Registration>;
  };
};

/** A plugin default export, as OpenCode loads it. */
export type Plugin = {
  readonly id: string;
  setup(context: OpenCodeContext): Promise<(() => Promise<void>) | void>;
};
