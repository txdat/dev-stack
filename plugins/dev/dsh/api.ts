// The parts of the DeepSeek Harness (DSH) Host API this plugin uses, declared structurally instead
// of imported: the DSH packages live in the profile, not in this checkout, so the linked bundle's
// imports resolve from here. `cordis-plugin-development`'s references document each member; the
// identifiers and shapes follow the installed 0.2.x runtime.

/** The services this plugin needs before it applies; a profile without one leaves it inactive. */
export const inject = ["commands", "skills", "systemPrompt", "tools", "workingDirectory"] as const;

export type TextBlock = { type: "text"; text: string };
export type ContentBlock = TextBlock | { type: string; [key: string]: unknown };

/**
 * A message's provenance: the producer's `kind`, which tells a user's prompt from injected context,
 * and the `form` an injected context declares, such as `notice`.
 */
export type MessageSource = {
  readonly kind?: string;
  readonly form?: string;
  readonly summary?: string;
};

/** A model-visible message: user, assistant, or a synthetic injection. */
export type Message = {
  readonly role?: string;
  readonly content?: string | readonly ContentBlock[];
  readonly source?: MessageSource;
};

export type UserMessage = Message & {
  readonly id?: string;
};

export type Session = {
  readonly header: { readonly cwd?: string };
};

export type Agent = {
  readonly session: Session;
  whenIdle(): Promise<void>;
  /** Queue model-facing context for the next step without waking the driver. */
  inject(message: UserMessage): void;
};

/** One durable session event; `session/event` publishes the appended event after commit. */
export type SessionEvent = {
  readonly type: string;
  readonly seq: number;
  readonly data?: unknown;
};

/** One pending tool call as `tools/pre-execute` and `tools/post-execute` publish it. */
export type ToolExecution = {
  readonly name: string;
  readonly arguments?: unknown;
  readonly agent?: Agent;
  readonly callId: string;
  readonly signal?: AbortSignal;
};

export type ToolResult = {
  readonly isError?: boolean;
  readonly content?: readonly ContentBlock[];
};

export type PreStepDecision =
  | { kind: "reject" }
  | { kind: "enter"; messages: UserMessage[]; startsRequestSeries?: true };

export type PreToolDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "cancel" };

export type PostToolDecision =
  | { kind: "accept"; content?: ContentBlock[] }
  | { kind: "block"; feedback: ContentBlock[] };

export type PromptSection = {
  readonly name: string;
  readonly order: number;
  readonly text: string | ((context: unknown) => string);
};

export type SkillRegistration = {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly whenToUse?: string;
  readonly path?: string;
  readonly invocation?: {
    readonly modelInvocable: boolean;
    readonly userInvocable: boolean;
  };
  readonly resourceBase?: {
    readonly kind: "directory";
    readonly path: string;
  };
};

export type CommandResult =
  | { readonly kind: "success"; readonly text?: string }
  | { readonly kind: "error"; readonly text: string };

export type CommandInvocation = {
  readonly agent: Agent;
  readonly rawInput: string;
  readonly signal?: AbortSignal;
};

export type CommandDefinition = {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint?: string };
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
};

/** The Cordis context a Host plugin's `apply` receives, as far as this plugin reads it. */
export type DshContext = {
  /** Listen to one Host event; the registration belongs to the plugin's context. */
  on: {
    (
      event: "agent/pre-step",
      handler: (
        payload: { agent: Agent; messages: UserMessage[] },
        next: () => Promise<PreStepDecision>,
      ) => Promise<PreStepDecision>,
    ): unknown;
    (
      event: "tools/pre-execute",
      handler: (
        exec: ToolExecution,
        next: () => Promise<PreToolDecision>,
      ) => Promise<PreToolDecision>,
    ): unknown;
    (
      event: "tools/post-execute",
      handler: (
        exec: ToolExecution,
        result: ToolResult,
        next: () => Promise<PostToolDecision>,
      ) => Promise<PostToolDecision>,
    ): unknown;
    (event: "session/event", handler: (session: Session, event: SessionEvent) => void): unknown;
  };
  readonly systemPrompt: {
    section(section: PromptSection): () => void;
  };
  readonly skills: {
    register(skill: SkillRegistration): () => void;
  };
  readonly commands: {
    register(command: CommandDefinition): () => void;
  };
  readonly workingDirectory: {
    get(session: Session): string;
  };
};

/** One text block's text, or the text of every text block a message holds. */
export const messageText = (message: Message | undefined): string => {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is TextBlock => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
};
