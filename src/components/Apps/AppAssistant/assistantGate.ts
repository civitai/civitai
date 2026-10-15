import type {
  ChatTool,
  ChatToolCall,
  ChatToolGate,
  ChatToolResult,
} from '@civitai/components-chat/civitai-chat';

/** The sandbox MCP server's id; the chat offers each of its tools as `sandbox__<tool>`. */
export const SANDBOX_SERVER_ID = 'sandbox';
const sandboxTool = (tool: string) => `${SANDBOX_SERVER_ID}__${tool}`;

/**
 * Tool calls one reply may make before every further call is refused. It only refuses calls: the page
 * cannot end a reply, so a model that ignores the refusal still runs to `APP_ASSISTANT_MAX_STEPS`.
 * Calls stand in for steps because a step's Buzz cost is not visible to the page.
 */
export const APP_ASSISTANT_TURN_TOOL_CALL_LIMIT = 150;

export const REPORT_READY = 'report_ready';
export const SET_CHECKLIST = 'set_checklist';
const CHECKLIST_MAX_ITEMS = 30;
const CHECKLIST_LABEL_MAX = 200;

export const TURN_LIMIT_REFUSAL = `This reply has made ${APP_ASSISTANT_TURN_TOOL_CALL_LIMIT} tool calls, the most one reply may make, so nothing more runs in it. Stop now: tell the user what is done and what is left, and that they can say "continue" to carry on.`;

const FILE_CHANGES = new Set(['write_file', 'edit_file', 'delete_path'].map(sandboxTool));
const PREVIEW_CHECK = sandboxTool('preview_check');
const RUN_COMMAND = sandboxTool('run_command');

// Only a command that is the check alone counts: `npm test | tail`, `; echo` or `|| true` could exit 0
// over a failing run. Arguments are flags and paths, nothing a shell would act on.
const CD = String.raw`(?:cd\s+[\w./-]+\s*&&\s*)?`;
// `--help`/`--version` exit 0 without checking anything.
const ARGS = String.raw`(?:\s+(?!-h\b|-v\b|--help\b|--version\b)[\w./=:@,-]+)*`;
const TEST_COMMAND = new RegExp(
  String.raw`^\s*${CD}(?:npm\s+(?:run\s+)?test|npx\s+(?:-y\s+)?vitest(?:\s+run)?)${ARGS}\s*$`
);
const TYPECHECK_COMMAND = new RegExp(
  String.raw`^\s*${CD}(?:npx\s+(?:-y\s+)?tsc|npm\s+run\s+typecheck)${ARGS}\s*$`
);

export type CheckKind = 'tests' | 'typecheck';

export function checkKindOf(command: unknown): CheckKind | null {
  if (typeof command !== 'string') return null;
  if (TEST_COMMAND.test(command)) return 'tests';
  if (TYPECHECK_COMMAND.test(command)) return 'typecheck';
  return null;
}

/** `sandbox__run_command`'s text starts with `exit_code: <n>`. */
export function exitCodeOf(output: unknown): number | null {
  if (typeof output !== 'string') return null;
  const match = /^exit_code:\s*(-?\d+)/.exec(output);
  return match ? Number(match[1]) : null;
}

/** `sandbox__preview_check`'s first line is `render: <verdict>`. */
export function previewVerdictOf(output: unknown): string | null {
  if (typeof output !== 'string') return null;
  return /^render:\s*([a-z_]+)/.exec(output)?.[1] ?? null;
}

export interface ChecklistItem {
  label: string;
  done: boolean;
}

/** The items as `set_checklist` was called with them; a JSON string of the array is accepted too. */
export function normalizeChecklist(raw: unknown): ChecklistItem[] | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > CHECKLIST_MAX_ITEMS) return null;
  const items: ChecklistItem[] = [];
  for (const entry of value) {
    const label = typeof entry === 'string' ? entry : (entry as { label?: unknown } | null)?.label;
    if (typeof label !== 'string' || !label.trim() || label.length > CHECKLIST_LABEL_MAX)
      return null;
    items.push({ label: label.trim(), done: (entry as { done?: unknown })?.done === true });
  }
  return items;
}

interface Verification {
  /** The last preview check's verdict since the last file change; null when none ran. */
  preview: string | null;
  tests: boolean | null;
  typecheck: boolean | null;
}

const unverified = (): Verification => ({ preview: null, tests: null, typecheck: null });

export interface AssistantGateDeps {
  /** Called with true when a reply reaches the tool-call limit, and with false when the next one starts. */
  onTurnLimit?: (reached: boolean) => void;
}

export interface AssistantGate {
  /** Call at the start of every reply. */
  startTurn(): void;
  /** Forget what was verified, e.g. when another sandbox opens. */
  reset(): void;
  beforeToolCall: ChatToolGate;
  onToolResult(result: ChatToolResult): void;
  tools: Record<string, ChatTool>;
}

/**
 * The page's own checks on the assistant's tool calls: a per-reply call limit, and a `report_ready`
 * that is refused until the tool results of this conversation show the app checked.
 */
export function createAssistantGate(deps: AssistantGateDeps = {}): AssistantGate {
  let conversationId: string | null = null;
  let turnCalls = 0;
  let limitReached = false;
  let verification = unverified();
  let checklist: ChecklistItem[] | null = null;

  const reset = () => {
    verification = unverified();
    checklist = null;
  };

  const missing = (): string[] => {
    const out: string[] = [];
    if (verification.preview === null)
      out.push(
        'Run sandbox__preview_check: it has not run since your last file change (write_file, edit_file, delete_path, or a run_command other than the test or typecheck run).'
      );
    else if (verification.preview !== 'ok')
      out.push(
        `The last sandbox__preview_check said render: ${verification.preview}. Fix that, then run it again.`
      );
    if (verification.tests === null)
      out.push(
        'Run the tests with sandbox__run_command as cd <blockId> && npm test, on its own and unpiped: they have not run since your last file change.'
      );
    else if (!verification.tests)
      out.push('The last test run failed. Fix it, then run cd <blockId> && npm test again.');
    if (verification.typecheck === null)
      out.push(
        'Run the typecheck with sandbox__run_command as cd <blockId> && npx tsc --noEmit, on its own and unpiped: it has not run since your last file change.'
      );
    else if (!verification.typecheck)
      out.push(
        'The last typecheck failed. Fix it, then run cd <blockId> && npx tsc --noEmit again.'
      );
    if (!checklist) out.push('Call set_checklist with the features the user asked for.');
    else {
      const open = checklist.filter((item) => !item.done).map((item) => item.label);
      if (open.length) out.push(`These checklist items are not done: ${open.join('; ')}.`);
    }
    return out;
  };

  const beforeToolCall: ChatToolGate = (name, _input, context) => {
    if (context.conversationId !== conversationId) {
      conversationId = context.conversationId;
      reset();
    }
    if (turnCalls >= APP_ASSISTANT_TURN_TOOL_CALL_LIMIT) {
      if (!limitReached) {
        limitReached = true;
        deps.onTurnLimit?.(true);
      }
      return { refuse: TURN_LIMIT_REFUSAL };
    }
    turnCalls++;
    if (name === REPORT_READY) {
      const reasons = missing();
      if (reasons.length) return { refuse: `Not ready yet. ${reasons.join(' ')}` };
    }
    return { allow: true };
  };

  const onToolResult = ({ name, input, output, isError, refused }: ChatToolResult) => {
    if (refused !== undefined) return;
    if (FILE_CHANGES.has(name)) verification = unverified();
    else if (name === PREVIEW_CHECK)
      verification.preview = isError ? 'error' : previewVerdictOf(output) ?? 'unreadable';
    else if (name === RUN_COMMAND) {
      const kind = checkKindOf((input as { command?: unknown } | null)?.command);
      // Any other command may have changed files (sed, a scaffold, npm install).
      if (kind) verification[kind] = !isError && exitCodeOf(output) === 0;
      else verification = unverified();
    }
  };

  const set_checklist: ChatTool = {
    description:
      'Show the user the list of features they asked for, as a checklist they can confirm or change. Call it before you scaffold, with every requested feature and nothing they did not ask for. Call it again with done: true on an item once it works and has a passing test. Changing the labels shows the user the new list and ends your reply.',
    activity: 'Writing the feature checklist…',
    inputSchema: {
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: CHECKLIST_MAX_ITEMS,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'One feature, in the user’s words.' },
              done: { type: 'boolean' },
            },
            required: ['label'],
          },
        },
      },
      required: ['items'],
    },
    execute(input) {
      const items = normalizeChecklist(input.items);
      if (!items)
        throw new Error(
          `items must be an array of 1-${CHECKLIST_MAX_ITEMS} { label, done } objects, each label 1-${CHECKLIST_LABEL_MAX} characters.`
        );
      const changed =
        !checklist ||
        checklist.length !== items.length ||
        checklist.some((item, i) => item.label !== items[i].label);
      checklist = items;
      if (changed)
        return {
          shown: true,
          awaitsUser: true,
          note: 'The user now sees this list. Your reply ends here: wait for them to confirm or change it.',
        };
      return { updated: true, open: items.filter((item) => !item.done).length };
    },
    render: renderChecklist,
  };

  const report_ready: ChatTool = {
    description:
      'Call this before you tell the user the app is ready, every time. It is refused until, since your last file change, sandbox__preview_check said render: ok, cd <blockId> && npm test and cd <blockId> && npx tsc --noEmit each exited 0 (run on their own, unpiped), and every set_checklist item is done. When it is refused, do what it says; never tell the user the app is ready without it.',
    activity: 'Checking the app is ready…',
    inputSchema: { properties: {} },
    execute: () => ({
      ready: true,
      note: 'Tell the user the app is ready for review, and what was checked: the preview check, the tests, the typecheck and each checklist item.',
    }),
  };

  return {
    startTurn() {
      turnCalls = 0;
      if (limitReached) {
        limitReached = false;
        deps.onTurnLimit?.(false);
      }
    },
    reset,
    beforeToolCall,
    onToolResult,
    tools: { [SET_CHECKLIST]: set_checklist, [REPORT_READY]: report_ready },
  };
}

/** The checklist card; the default card for input it cannot read. */
export function renderChecklist(call: ChatToolCall): HTMLElement | undefined {
  const items = normalizeChecklist((call.input as { items?: unknown } | null)?.items);
  if (!items) return undefined;
  const card = document.createElement('div');
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', 'Feature checklist');
  card.style.cssText =
    'border:1px solid var(--civitai-color-border, #8884);border-radius:8px;padding:8px 12px;margin:4px 0';
  const title = document.createElement('div');
  title.textContent = 'Feature checklist';
  title.style.fontWeight = '600';
  const list = document.createElement('ul');
  list.style.cssText = 'list-style:none;margin:4px 0 0;padding:0';
  for (const item of items) {
    const row = document.createElement('li');
    row.textContent = `${item.done ? '☑' : '☐'} ${item.label}`;
    list.append(row);
  }
  card.append(title, list);
  return card;
}
