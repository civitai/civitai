/**
 * The shapes App Assistant's tools and gate take, written out here so this package depends on
 * nothing. They match `@civitai/components-chat`'s `ChatTool`, `ChatToolGate` and `ChatToolResult`
 * (0.19 and 0.21) structurally, so the page hands them to `<civitai-chat>` and the runner to
 * `gateToolSet` as they are.
 */

/** A tool the assistant may call, without how the page shows it. */
export interface AssistantTool {
  description: string;
  /** Shown while it runs. */
  activity?: string;
  /** JSON Schema of the input object (its `properties`, `required`). */
  inputSchema: Record<string, unknown>;
  /** Its return value goes back to the assistant; a throw becomes the error it reads. */
  execute(input: Record<string, unknown>): unknown;
}

/** The gate's answer about one call: run it, refuse it, or refuse it and end the reply. */
export type ToolDecision =
  | { allow: true }
  | { refuse: string; stop?: false }
  | { refuse: string; stop: true; message?: string }
  | void;

export interface ToolGateContext {
  conversationId: string;
  /** The same for every call of one reply, a subagent's included; a new one for the next. */
  reply: number;
  signal?: AbortSignal;
  /** Set only on a subagent's call: the id of the `dispatch_agent` call that started it. */
  subagent?: string;
}

export type ToolGate = (
  name: string,
  input: unknown,
  context: ToolGateContext
) => ToolDecision | Promise<ToolDecision>;

/**
 * Waits one macrotask. The chat starts every call of a step together, so a call that judges the
 * checks (report_ready, submit_for_review) waits here first: without it, a write made in the same
 * step has not reached the gate yet and the app is judged ready before that write lands.
 */
export const letStepCallsReachGate = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** One finished call, as the gate is told of it. */
export interface ToolResult {
  name: string;
  input: unknown;
  output: unknown;
  isError: boolean;
  /** Set when the gate refused it. */
  refused?: string;
  /** Set when it ended the reply, or did not run because another call did. */
  stopped?: true;
  /** Set only on a subagent's call. */
  subagent?: string;
}
