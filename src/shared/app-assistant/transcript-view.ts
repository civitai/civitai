/**
 * A saved App Assistant chat (its snapshot) as moderators read it: turn by turn, the user's words,
 * then the reply's text and tool calls in order, each tool's output cut to `toolOutputChars` so a
 * page of transcript stays readable (the full output stays in the snapshot). Pure.
 */

export interface TranscriptStep {
  kind: 'text' | 'reasoning' | 'tool';
  /** text / reasoning: the words. */
  text?: string;
  /** tool: its name, input, and output (cut), and whether it failed. */
  tool?: string;
  toolCallId?: string;
  input?: unknown;
  output?: string;
  outputTruncated?: boolean;
  isError?: boolean;
}

export interface TranscriptTurnView {
  seq: number;
  createdAt: string | null;
  user: string;
  status: string | null;
  buzz: number | null;
  error: string | null;
  steps: TranscriptStep[];
}

export interface TranscriptView {
  conversationId: string;
  title: string | null;
  model: string | null;
  turns: TranscriptTurnView[];
}

/** The most a tool's output is cut to, whatever a caller asks. */
export const MAX_TOOL_OUTPUT_CHARS = 20_000;
export const DEFAULT_TOOL_OUTPUT_CHARS = 2_000;

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === 'object';
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (isRec(part) && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** A tool result's output as text, as the model saw it. */
function outputText(output: unknown): { text: string; isError: boolean } {
  if (!isRec(output) || typeof output.type !== 'string')
    return { text: JSON.stringify(output) ?? '', isError: false };
  const value = output.value;
  const isError = output.type.startsWith('error') || output.type === 'execution-denied';
  if (typeof value === 'string') return { text: value, isError };
  if (output.type === 'execution-denied')
    return { text: String(output.reason ?? 'denied'), isError };
  return {
    text: JSON.stringify(value) ?? '',
    isError: isError || (isRec(value) && value.error !== undefined),
  };
}

export function transcriptView(
  metadata: unknown,
  { toolOutputChars = DEFAULT_TOOL_OUTPUT_CHARS }: { toolOutputChars?: number } = {}
): TranscriptView {
  const cut = Math.max(0, Math.min(MAX_TOOL_OUTPUT_CHARS, Math.floor(toolOutputChars)));
  const head = isRec(metadata) ? metadata : {};
  const turns: TranscriptTurnView[] = [];
  for (const turn of Array.isArray(head.turns) ? head.turns : []) {
    if (!isRec(turn)) continue;
    const assistant = isRec(turn.assistant) ? turn.assistant : null;
    const messages = Array.isArray(assistant?.messages) ? (assistant!.messages as unknown[]) : [];
    const results = new Map<string, { text: string; isError: boolean }>();
    for (const message of messages) {
      if (!isRec(message) || message.role !== 'tool' || !Array.isArray(message.content)) continue;
      for (const part of message.content)
        if (isRec(part) && part.type === 'tool-result' && typeof part.toolCallId === 'string')
          results.set(part.toolCallId, outputText(part.output));
    }
    const steps: TranscriptStep[] = [];
    for (const message of messages) {
      if (!isRec(message) || message.role !== 'assistant') continue;
      if (typeof message.content === 'string') {
        if (message.content) steps.push({ kind: 'text', text: message.content });
        continue;
      }
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (!isRec(part)) continue;
        if (part.type === 'text' && typeof part.text === 'string' && part.text)
          steps.push({ kind: 'text', text: part.text });
        else if (part.type === 'reasoning' && typeof part.text === 'string' && part.text)
          steps.push({ kind: 'reasoning', text: part.text });
        else if (part.type === 'tool-call') {
          const id = str(part.toolCallId) ?? '';
          const result = results.get(id);
          const full = result?.text ?? '';
          steps.push({
            kind: 'tool',
            tool: str(part.toolName) ?? '?',
            toolCallId: id,
            input: part.input,
            output: full.slice(0, cut),
            outputTruncated: full.length > cut,
            isError: result ? result.isError : true,
          });
        }
      }
    }
    const user = isRec(turn.user) ? text(turn.user.content) : '';
    turns.push({
      seq: typeof turn.seq === 'number' ? turn.seq : turns.length + 1,
      createdAt: str(turn.createdAt),
      user,
      status: str(assistant?.status),
      buzz: typeof assistant?.buzz === 'number' ? assistant.buzz : null,
      error: str(assistant?.error),
      steps,
    });
  }
  return {
    conversationId: str(head.conversationId) ?? '',
    title: str(head.title),
    model: str(head.model),
    turns,
  };
}
