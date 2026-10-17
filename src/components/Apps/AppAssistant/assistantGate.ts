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
 * Tool calls one reply may make. The next call does not run and ends the reply, with no further model
 * request; Continue starts a new reply with a fresh count. Calls stand in for steps because a step's Buzz
 * cost is not visible to the page.
 */
export const APP_ASSISTANT_TURN_TOOL_CALL_LIMIT = 150;

export const REPORT_READY = 'report_ready';
export const SET_CHECKLIST = 'set_checklist';
const CHECKLIST_MAX_ITEMS = 30;
const CHECKLIST_LABEL_MAX = 200;

/** What the assistant reads as the refused call's error, in the reply after. */
export const TURN_LIMIT_REFUSAL = `This reply made ${APP_ASSISTANT_TURN_TOOL_CALL_LIMIT} tool calls, the most one reply may make, so it ended before this call ran.`;
/** What the user reads under the reply the limit ended. */
export const TURN_LIMIT_MESSAGE = `App Assistant stopped this reply after ${APP_ASSISTANT_TURN_TOOL_CALL_LIMIT} tool calls, the most one reply may make. Press Continue to let it carry on.`;

// Every other sandbox tool clears the checks: write_file, edit_file and delete_path change files, and
// dev_server_start/_restart run a command (the dev script, or one the assistant passes). A tool the
// sandbox adds later clears them too until it is listed here.
const KEEPS_CHECKS = new Set(
  [
    'read_file',
    'list_dir',
    'dev_server_status',
    'dev_server_logs',
    'dev_server_stop',
    'tunnel_key',
    'tunnel_connect',
    'tunnel_status',
    'tunnel_disconnect',
  ].map(sandboxTool)
);
const SANDBOX_PREFIX = sandboxTool('');
const PREVIEW_CHECK = sandboxTool('preview_check');
const RUN_COMMAND = sandboxTool('run_command');

// Only the bare check counts: a pipe, `;`, `||`, a newline, a flag (`-u`, `--help`), a path filter
// or a `-p` config can exit 0 without the whole check passing. Spaces and tabs only, since a newline
// starts a new command.
const SP = '[ \\t]+';
const CD = `(?:cd${SP}[\\w./-]+[ \\t]*&&[ \\t]*)?`;
const TEST_COMMAND = new RegExp(
  `^[ \\t]*${CD}(?:npm${SP}(?:run${SP})?test|npx${SP}(?:-y${SP})?vitest${SP}run)[ \\t]*$`
);
const TYPECHECK_COMMAND = new RegExp(
  `^[ \\t]*${CD}(?:npx${SP}(?:-y${SP})?tsc${SP}--noEmit|npm${SP}run${SP}typecheck)[ \\t]*$`
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
  /** The last preview check's verdict since the last file change or other command; null when none ran. */
  preview: string | null;
  tests: boolean | null;
  typecheck: boolean | null;
}

const unverified = (): Verification => ({ preview: null, tests: null, typecheck: null });

/** What Build it sends as the user. */
export const BUILD_IT_MESSAGE = 'Looks good — build it.';

export interface AssistantGate {
  /** Forget what was verified, e.g. when another sandbox opens. */
  reset(): void;
  /** The user answered the checklist another way (sent a message, opened another chat): remove Build it. */
  answered(): void;
  beforeToolCall: ChatToolGate;
  onToolResult(result: ChatToolResult): void;
  tools: Record<string, ChatTool>;
}

/**
 * The page's own checks on the assistant's tool calls: a per-reply call limit, and a `report_ready`
 * that is refused until the tool results of this conversation show the app checked.
 */
export function createAssistantGate({
  refuse,
  onReply,
  onBuild,
}: {
  /** The page's own refusal for a call, if any; counted against the per-reply limit like any call. */
  refuse?: (name: string) => string | null;
  /** Told when a new reply makes its first tool call, before that call's refusal is asked. */
  onReply?: () => void;
  /** The user pressed Build it under a checklist that waits for them. */
  onBuild?: () => void;
} = {}): AssistantGate {
  let conversationId: string | null = null;
  // The chat numbers every reply, Continue and Retry included.
  let reply: number | null = null;
  let turnCalls = 0;
  let verification = unverified();
  let checklist: ChecklistItem[] | null = null;
  // Calls other than report_ready that were allowed and have not returned. The chat starts every call of
  // a step together, so a write in the same step as report_ready could land after it said ready.
  let running = 0;
  // Which set_checklist call ended the last reply and waits for the user; only its card offers Build it.
  // Per page load, so a card restored from an earlier visit never matches.
  const page = Math.random().toString(36).slice(2, 10);
  let checklistCalls = 0;
  let awaiting: string | null = null;
  let buildButtons: HTMLButtonElement[] = [];

  const answered = () => {
    awaiting = null;
    for (const button of buildButtons) button.remove();
    buildButtons = [];
  };

  const reset = () => {
    verification = unverified();
    checklist = null;
  };

  const missing = (): string[] => {
    const out: string[] = [];
    if (verification.preview === null)
      out.push(
        'Run sandbox__preview_check: it has not run since your last file change or other command (write_file, edit_file, delete_path, dev_server_start, dev_server_restart, or a run_command other than the test or typecheck run).'
      );
    else if (verification.preview !== 'ok')
      out.push(
        `The last sandbox__preview_check said render: ${verification.preview}. Fix that, then run it again.`
      );
    if (verification.tests === null)
      out.push(
        'Run the tests with sandbox__run_command as cd <blockId> && npm test, on its own and unpiped: they have not run since your last file change or other command.'
      );
    else if (!verification.tests)
      out.push('The last test run failed. Fix it, then run cd <blockId> && npm test again.');
    if (verification.typecheck === null)
      out.push(
        'Run the typecheck with sandbox__run_command as cd <blockId> && npx tsc --noEmit, on its own and unpiped: it has not run since your last file change or other command.'
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

  const notReady = (): string | null => {
    const reasons = missing();
    return reasons.length
      ? `Not ready yet. ${reasons.join(' ')} Then call report_ready again.`
      : null;
  };

  const beforeToolCall: ChatToolGate = (name, _input, context) => {
    if (context.conversationId !== conversationId) {
      conversationId = context.conversationId;
      reset();
    }
    if (context.reply !== reply) {
      reply = context.reply;
      turnCalls = 0;
      running = 0;
      answered();
      onReply?.();
    }
    if (turnCalls >= APP_ASSISTANT_TURN_TOOL_CALL_LIMIT)
      return { refuse: TURN_LIMIT_REFUSAL, stop: true, message: TURN_LIMIT_MESSAGE };
    turnCalls++;
    const refusedByPage = refuse?.(name);
    if (refusedByPage) return { refuse: refusedByPage };
    if (name === REPORT_READY) {
      const refusal = notReady();
      if (refusal) return { refuse: refusal };
    } else running++;
    return { allow: true };
  };

  const onToolResult = ({ name, input, output, isError, refused, stopped }: ChatToolResult) => {
    // Neither ran. One its ended reply did not run stays counted in `running`; the next reply starts at 0.
    if (refused !== undefined || stopped) return;
    if (name !== REPORT_READY) running = Math.max(0, running - 1);
    if (name === PREVIEW_CHECK)
      verification.preview = isError ? 'error' : previewVerdictOf(output) ?? 'unreadable';
    else if (name === RUN_COMMAND) {
      const kind = checkKindOf((input as { command?: unknown } | null)?.command);
      // Any other command may have changed files (sed, a scaffold, npm install).
      if (kind) verification[kind] = !isError && exitCodeOf(output) === 0;
      else verification = unverified();
    } else if (name.startsWith(SANDBOX_PREFIX) && !KEEPS_CHECKS.has(name))
      verification = unverified();
  };

  const set_checklist: ChatTool = {
    description:
      'Show the user the list of features they asked for, as a checklist with a Build it button. Call it before you scaffold, with every requested feature and nothing they did not ask for, and in the same message, before the call, write one short sentence asking the user to tap Build it or say what to change. Call it again with done: true on an item once it works and has a passing test. Changing the labels shows the user the new list and ends your reply.',
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
      if (changed) {
        awaiting = `${page}-${++checklistCalls}`;
        return {
          shown: true,
          awaitsUser: true,
          checklist: awaiting,
          note: 'The user now sees this list with a Build it button. Your reply ends here: wait for them to press it or say what to change.',
        };
      }
      return { updated: true, open: items.filter((item) => !item.done).length };
    },
    render(call) {
      const card = renderChecklist(call);
      const shownAs = (call.output as { checklist?: unknown } | null | undefined)?.checklist;
      if (!card || !onBuild || !awaiting || shownAs !== awaiting) return card;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Build it';
      button.style.cssText =
        'min-height:44px;margin-top:8px;padding:0 16px;border-radius:6px;border:0;cursor:pointer;font:inherit;font-weight:600;color:#fff;background:var(--civitai-color-primary, #228be6)';
      // It goes once the message does (`answered`): a send while the reply is still ending does nothing.
      button.addEventListener('click', onBuild);
      buildButtons.push(button);
      card.append(button);
      return card;
    },
  };

  const report_ready: ChatTool = {
    description:
      'Call this on its own, before you tell the user the app is ready, every time. It is refused until, since your last file change or other command (including dev_server_start or dev_server_restart), sandbox__preview_check said render: ok, cd <blockId> && npm test and cd <blockId> && npx tsc --noEmit each exited 0 (run on their own, unpiped), and every set_checklist item is done. When it is refused, do what it says; never tell the user the app is ready without it.',
    activity: 'Checking the app is ready…',
    inputSchema: { properties: {} },
    async execute() {
      // Let the rest of this step's calls reach the gate first.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (running > 0)
        throw new Error(
          'Call report_ready on its own, once your other tool calls have returned: they can still change the app.'
        );
      const refusal = notReady();
      if (refusal) throw new Error(refusal);
      return {
        ready: true,
        note: 'Tell the user the app is ready for review, and what was checked: the preview check, the tests, the typecheck and each checklist item. The user sees a card saying these checks passed.',
      };
    },
    render: renderReady,
  };

  return {
    reset,
    answered,
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

/** The card a passing report_ready shows: the user's sign that the checks ran. The default card otherwise. */
export function renderReady(call: ChatToolCall): HTMLElement | undefined {
  if (call.state !== 'done' || (call.output as { ready?: unknown } | null)?.ready !== true)
    return undefined;
  const card = document.createElement('div');
  card.setAttribute('role', 'status');
  card.style.cssText =
    'border:1px solid var(--civitai-color-border, #8884);border-radius:8px;padding:8px 12px;margin:4px 0';
  card.textContent =
    '✓ Checked: the preview renders, the tests and the typecheck pass, and every checklist item is done.';
  return card;
}
