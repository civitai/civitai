import { CREATE_APP, USE_OPEN_APP } from './app-tools';
import type { AssistantTool, ToolGate, ToolResult } from './tool';

/** The sandbox MCP server's id; the chat offers each of its tools as `sandbox__<tool>`. */
export const SANDBOX_SERVER_ID = 'sandbox';
const sandboxTool = (tool: string) => `${SANDBOX_SERVER_ID}__${tool}`;

/**
 * Tool calls one reply may make. The next call does not run and ends the reply, with no further model
 * request; Continue starts a new reply with a fresh count. Calls stand in for steps because a step's Buzz
 * cost is not visible to the page. A subagent's calls are not counted: the chat caps those per subagent.
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

/**
 * Sandbox tools that cannot change the app: what a chat may call on an app open in it that it has not
 * chosen (`openAppNotChosen`). Every other sandbox tool, one the sandbox adds later included, may.
 */
const READS_APP = new Set([...KEEPS_CHECKS, PREVIEW_CHECK]);

/** Whether a call can change the open app's files (a test or typecheck run cannot). */
export function changesApp(name: string, input: unknown): boolean {
  if (!name.startsWith(SANDBOX_PREFIX) || READS_APP.has(name)) return false;
  return !(name === RUN_COMMAND && checkKindOf((input as { command?: unknown } | null)?.command));
}

/**
 * What a change to the open app is refused with in a chat that neither made it (`create_app`) nor
 * chose it (`use_open_app`): a new chat opened beside an app must not build over that app.
 */
export const openAppNotChosen = (app: string) =>
  `Nothing in ${app} was changed: this chat has not been asked to change it. If the user asked for a different app, call create_app to make a new one and leave ${app} as it is. If they clearly asked to change ${app} itself, call use_open_app with app ${app}, then make the change. If it is not clear which, ask them "Make a new app, or replace ${app}?" and wait for their answer.`;

/**
 * The app a finished `create_app` or `use_open_app` call chose for the chat, if it did. Only a
 * `create_app` that made a new app chooses it: one that found an app the user already had
 * (`existed`: the open one, a paused one it started, one made elsewhere) chooses nothing.
 */
function chosenAppOf({ name, output, isError, refused, stopped, subagent }: ToolResult) {
  if (name !== CREATE_APP && name !== USE_OPEN_APP) return null;
  if (isError || refused !== undefined || stopped || subagent !== undefined) return null;
  const result = output as { app?: unknown; existed?: unknown } | null | undefined;
  if (name === CREATE_APP && result?.existed === true) return null;
  return typeof result?.app === 'string' ? result.app : null;
}

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

/** The `set_checklist` call that ended a reply and waits for the user, and the app it was shown for. */
export interface AwaitingChecklist {
  id: string;
  app: string | null;
}

export interface GateCoreOptions {
  /** A refusal of the caller's own for a call, if any; counted against the per-reply limit like any call. */
  refuse?: (name: string) => string | null;
  /** Told when a new reply makes its first tool call, before that call's refusal is asked. */
  onReply?: () => void;
  /** The app open now; a checklist belongs to the app it was shown for. */
  currentApp?: () => string | null;
  /** Ids the checklists this gate shows are named by; per gate, so one from elsewhere never matches. */
  checklistPrefix?: string;
  /**
   * The key of the app open now, written into every `set_checklist` result (`app`) so a later reply
   * carries a checklist over only for the app it was made for (`restore`). The server runner sets it;
   * the page does not, and its results stay as they were.
   */
  checklistApp?: () => string | null;
  /**
   * The key of the app open now. Set, a call that can change it (`changesApp`) is refused
   * (`openAppNotChosen`) until this conversation made that app with `create_app` or chose it with
   * `use_open_app`. Both the page and the server runner set it.
   */
  openApp?: () => string | null;
}

/** What a gate starts from: what this conversation already did (a server run picking a reply up). */
export interface GateRestore {
  conversationId: string;
  /** The calls of the conversation's earlier replies, in order: only their checklist carries over. */
  earlier: readonly ToolResult[];
  /**
   * The calls the reply being carried on already made, in order: they count against its call limit
   * and decide what is verified, as they did when they ran. A `create_app` among them that opened
   * another app than `app` starts the checks and the checklist over, as the page does when another
   * app opens.
   */
  current: readonly ToolResult[];
  /**
   * The key of the app open now. With `checklistApp` set, only checklists made for this app carry
   * over; one without an app (made in the browser) does not.
   */
  app?: string | null;
}

export interface GateCore {
  /** Forget what was verified, e.g. when another sandbox opens. */
  reset(): void;
  beforeToolCall: ToolGate;
  onToolResult(result: ToolResult): void;
  /** `set_checklist` and `report_ready`, without a view. */
  tools: { [SET_CHECKLIST]: AssistantTool; [REPORT_READY]: AssistantTool };
  /** The checklist waiting for the user's Build it, if one is. */
  awaiting(): AwaitingChecklist | null;
  /** The user answered the checklist another way: nothing waits for Build it any more. */
  clearAwaiting(): void;
  /** Starts from what the conversation already did; call before the first call of the reply. */
  restore(state: GateRestore): void;
}

/**
 * App Assistant's own checks on the assistant's tool calls, as both runners apply them: a per-reply
 * call limit, and a `report_ready` that is refused until the tool results of this conversation show
 * the app checked.
 */
export function createGateCore({
  refuse,
  onReply,
  currentApp,
  checklistPrefix = Math.random().toString(36).slice(2, 10),
  checklistApp,
  openApp,
}: GateCoreOptions = {}): GateCore {
  let conversationId: string | null = null;
  // The app each conversation made or chose, which it may change, by conversation id: the page's one
  // gate serves every chat the user moves between. Not cleared by `reset`: the page resets as the app
  // it just made opens, after the `create_app` result chose it.
  const chosenApps = new Map<string, string>();
  const choose = (result: ToolResult) => {
    const app = chosenAppOf(result);
    if (app !== null && conversationId !== null) chosenApps.set(conversationId, app);
  };
  // The chat numbers every reply, Continue and Retry included.
  let reply: number | null = null;
  let turnCalls = 0;
  // Calls the reply being carried on made before this gate existed: where its count starts.
  let carriedCalls = 0;
  let verification = unverified();
  let checklist: ChecklistItem[] | null = null;
  // Calls other than report_ready that were allowed and have not returned. The chat starts every call of
  // a step together, so a write in the same step as report_ready could land after it said ready. A
  // dispatch_agent counts until its subagent returns.
  let running = 0;
  let checklistCalls = 0;
  let awaiting: AwaitingChecklist | null = null;

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

  const beforeToolCall: ToolGate = (name, input, context) => {
    if (context.conversationId !== conversationId) {
      conversationId = context.conversationId;
      reset();
    }
    if (context.reply !== reply) {
      reply = context.reply;
      turnCalls = carriedCalls;
      carriedCalls = 0;
      running = 0;
      awaiting = null;
      onReply?.();
    }
    if (context.subagent === undefined) {
      if (turnCalls >= APP_ASSISTANT_TURN_TOOL_CALL_LIMIT)
        return { refuse: TURN_LIMIT_REFUSAL, stop: true, message: TURN_LIMIT_MESSAGE };
      turnCalls++;
    }
    const refused = refuse?.(name);
    if (refused) return { refuse: refused };
    const appOpen = openApp?.() ?? null;
    if (
      appOpen !== null &&
      appOpen !== chosenApps.get(context.conversationId) &&
      changesApp(name, input)
    )
      return { refuse: openAppNotChosen(appOpen) };
    if (name === REPORT_READY) {
      const refusal = notReady();
      if (refusal) return { refuse: refusal };
    } else running++;
    return { allow: true };
  };

  /** What a finished call says about the checks; the checklist is set by `set_checklist` itself. */
  const verify = ({ name, input, output, isError }: ToolResult) => {
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

  const onToolResult = (result: ToolResult) => {
    const { name, output, isError, refused, stopped, subagent } = result;
    // Neither ran. One its ended reply did not run stays counted in `running`; the next reply starts at 0.
    if (refused !== undefined || stopped) return;
    if (name !== REPORT_READY) running = Math.max(0, running - 1);
    choose(result);
    verify(result);
    // A checklist a server runner showed: its Build it is the one waiting (the page shows the card).
    const shown = output as { awaitsUser?: unknown; checklist?: unknown } | null | undefined;
    if (
      name === SET_CHECKLIST &&
      !isError &&
      subagent === undefined &&
      shown?.awaitsUser === true &&
      typeof shown.checklist === 'string'
    )
      awaiting = { id: shown.checklist, app: currentApp?.() ?? null };
  };

  /** The checklist a successful `set_checklist` call left. */
  const checklistOf = ({ name, input, isError, refused, stopped }: ToolResult) =>
    name === SET_CHECKLIST && !isError && refused === undefined && !stopped
      ? normalizeChecklist((input as { items?: unknown } | null)?.items)
      : null;

  const set_checklist: AssistantTool = {
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
      const tag = checklistApp ? { app: checklistApp() } : {};
      if (changed) {
        awaiting = { id: `${checklistPrefix}-${++checklistCalls}`, app: currentApp?.() ?? null };
        return {
          shown: true,
          awaitsUser: true,
          checklist: awaiting.id,
          note: 'The user now sees this list with a Build it button. Your reply ends here: wait for them to press it or say what to change.',
          ...tag,
        };
      }
      return { updated: true, open: items.filter((item) => !item.done).length, ...tag };
    },
  };

  const report_ready: AssistantTool = {
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
  };

  return {
    reset,
    beforeToolCall,
    onToolResult,
    tools: { [SET_CHECKLIST]: set_checklist, [REPORT_READY]: report_ready },
    awaiting: () => awaiting,
    clearAwaiting: () => {
      awaiting = null;
    },
    restore({ conversationId: id, earlier, current, app = null }) {
      conversationId = id;
      reset();
      chosenApps.delete(id);
      for (const result of [...earlier, ...current]) choose(result);
      // Without app tags (the page), every checklist counts, as it did before.
      const forThisApp = (result: ToolResult) =>
        !checklistApp || (result.output as { app?: unknown } | null)?.app === app;
      for (const result of earlier)
        if (forThisApp(result)) checklist = checklistOf(result) ?? checklist;
      for (const result of current) {
        if (opensOtherApp(result, app)) {
          reset();
          continue;
        }
        if (forThisApp(result)) checklist = checklistOf(result) ?? checklist;
        if (result.refused === undefined && !result.stopped) verify(result);
      }
      carriedCalls = current.filter((result) => result.subagent === undefined).length;
    },
  };
}

/** A `create_app` call that opened an app other than `app`: the checks start over. */
function opensOtherApp(
  { name, output, isError, refused, stopped }: ToolResult,
  app: string | null
): boolean {
  const opened = (output as { app?: unknown } | null)?.app;
  return (
    name === CREATE_APP &&
    !isError &&
    refused === undefined &&
    !stopped &&
    typeof opened === 'string' &&
    opened !== app
  );
}
