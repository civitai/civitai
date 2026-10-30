import { CREATE_APP, USE_OPEN_APP } from './app-tools';
import { letStepCallsReachGate, type AssistantTool, type ToolGate, type ToolResult } from './tool';
import { SUBMIT_FOR_REVIEW, createSubmitTool } from './submit';

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
/** Calls that only read the checks: never counted as still running, and refused until the app is ready. */
const READS_CHECKS = new Set([REPORT_READY, SUBMIT_FOR_REVIEW]);
const CHECKLIST_MAX_ITEMS = 30;
const CHECKLIST_LABEL_MAX = 200;

/** report_ready's refusals about the app's data (see `DataSource`). */
export const DATA_REQUIRED =
  "Say where what the app shows comes from: call report_ready with data: 'civitai' (from Civitai), 'sample' (made-up sample data) or 'none' (no Civitai data).";
export const SAMPLE_NOT_AGREED =
  "The user has not agreed to sample data. Tell them plainly the app would show made-up sample data, not real Civitai data, and why; offer to label it as sample data or to change the app to what Civitai provides. Only once they agree, call set_checklist with data: 'sample'.";
export const SAMPLE_LABEL_MISSING =
  'An app showing sample data must say so: add a visible "Sample data" label at the top of the app, then run sandbox__preview_check, whose visible text must show it.';
export const DATA_NOT_AS_PROMISED =
  'The checklist told the user the app shows Civitai data, but report_ready says it shows none. Make it show the Civitai data the user asked for, or tell them why it cannot and agree a change through set_checklist.';

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
 * What report_ready and submit_for_review are refused with while the app's `block.manifest.json`
 * declares sensitive scopes (`scopes`) with no `scopeJustifications` entry: civitai refuses such a
 * submission.
 */
export const unjustifiedScopesRefusal = (scopes: readonly string[], tool: string) =>
  `Not ready yet. block.manifest.json asks for ${scopes.join(
    ', '
  )}, which Civitai accepts only with a reason: add to it "scopeJustifications": { "${
    scopes[0]
  }": "<why the app needs it, in one plain sentence>" }${
    scopes.length > 1 ? ', with an entry for each of them' : ''
  }, and tell the user in one sentence what you wrote. Then run the preview check, the tests and the typecheck again, and call ${tool} again.`;

/** What `submit_for_review` is refused with before any report_ready passed in this chat. */
export const SUBMIT_NEEDS_READY =
  'Not ready yet. Call report_ready first, on its own; once it says the app is ready, call submit_for_review again.';

/**
 * What `submit_for_review` is refused with in a chat that neither made the open app (`create_app`)
 * nor chose it (`use_open_app`): a new chat must not submit an app it did not build.
 */
export const submitNotChosen = (app: string) =>
  `${app} was not submitted: this chat did not make it or work on it. If the user clearly asked to submit ${app} itself, call use_open_app with app ${app}, check it is ready, then call submit_for_review again; otherwise ask them which app they mean.`;

/**
 * The app a finished `create_app` or `use_open_app` call chose for the chat, if it did. Only a
 * `create_app` that made a new app chooses it: one that found an app the user already had
 * (`existed`: the open one, a paused one it started, one made elsewhere) chooses nothing.
 */
export function chosenAppOf({ name, output, isError, refused, stopped, subagent }: ToolResult) {
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

/**
 * Where what the app shows comes from, as `report_ready` must declare it: `civitai` (from Civitai,
 * through @civitai/sdk), `sample` (made-up data in place of Civitai's) or `none` (no Civitai data).
 */
export type DataSource = 'civitai' | 'sample' | 'none';
export const DATA_SOURCES: readonly DataSource[] = ['civitai', 'sample', 'none'];

export function dataSourceOf(raw: unknown): DataSource | null {
  return DATA_SOURCES.includes(raw as DataSource) ? (raw as DataSource) : null;
}

/** The label an app showing sample data must show, as the preview check's visible text has it. */
export const SAMPLE_DATA_LABEL = 'Sample data';

/** Whether a `sandbox__preview_check` report's visible text shows {@link SAMPLE_DATA_LABEL}. */
export function showsSampleDataLabel(output: unknown): boolean {
  if (typeof output !== 'string') return false;
  const at = output.indexOf('\n## visible text');
  return at >= 0 && output.slice(at).toLowerCase().includes(SAMPLE_DATA_LABEL.toLowerCase());
}

interface Verification {
  /** The last preview check's verdict since the last file change or other command; null when none ran. */
  preview: string | null;
  /** Whether that preview check's visible text showed the sample-data label. */
  sampleLabel: boolean;
  tests: boolean | null;
  typecheck: boolean | null;
}

const unverified = (): Verification => ({
  preview: null,
  sampleLabel: false,
  tests: null,
  typecheck: null,
});

export interface GateCoreOptions {
  /** A refusal of the caller's own for a call, if any; counted against the per-reply limit like any call. */
  refuse?: (name: string) => string | null;
  /** Told when a new reply makes its first tool call, before that call's refusal is asked. */
  onReply?: () => void;
  /** Ids the Submit for review offers this gate makes are named by; per gate, so one from elsewhere never matches. */
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
  /**
   * The sensitive scopes the open app's `block.manifest.json` declares without a justification
   * (empty when none, or when it cannot be read). Set, report_ready and submit_for_review are
   * refused (`unjustifiedScopesRefusal`) while it names any.
   */
  unjustifiedScopes?: () => Promise<readonly string[]>;
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
  /** `set_checklist`, `report_ready` and `submit_for_review`, without a view. */
  tools: {
    [SET_CHECKLIST]: AssistantTool;
    [REPORT_READY]: AssistantTool;
    [SUBMIT_FOR_REVIEW]: AssistantTool;
  };
  /** Starts from what the conversation already did; call before the first call of the reply. */
  restore(state: GateRestore): void;
  /**
   * A saved call of `conversationId` as a reopened chat shows it (the page, which keeps no history):
   * what it chose counts, as `restore` reads it on the runner, unless this page load chose since.
   */
  restoreChoice(conversationId: string, result: ToolResult): void;
}

/**
 * App Assistant's own checks on the assistant's tool calls, as both runners apply them: a per-reply
 * call limit, and a `report_ready` that is refused until the tool results of this conversation show
 * the app checked.
 */
export function createGateCore({
  refuse,
  onReply,
  checklistPrefix = Math.random().toString(36).slice(2, 10),
  checklistApp,
  openApp,
  unjustifiedScopes,
}: GateCoreOptions = {}): GateCore {
  let conversationId: string | null = null;
  // Keyed by conversation: the page's one gate serves every chat. Not cleared by reset: the page resets
  // as the new app opens, after create_app's result chose it.
  const chosenApps = new Map<string, string>();
  // Chosen by a call made since this gate began, which a saved call shown later never overrides.
  const chosenLive = new Set<string>();
  const choose = (result: ToolResult) => {
    const app = chosenAppOf(result);
    if (app === null || conversationId === null) return;
    chosenApps.set(conversationId, app);
    chosenLive.add(conversationId);
  };
  // The chat numbers every reply, Continue and Retry included.
  let reply: number | null = null;
  let turnCalls = 0;
  // Calls the reply being carried on made before this gate existed: where its count starts.
  let carriedCalls = 0;
  let verification = unverified();
  let checklist: ChecklistItem[] | null = null;
  // What the checklist the user was shown said the app's data would be; null when it said nothing.
  let checklistData: DataSource | null = null;
  // Calls other than report_ready that were allowed and have not returned. The chat starts every call of
  // a step together, so a write in the same step as report_ready could land after it said ready. A
  // dispatch_agent counts until its subagent returns.
  let running = 0;

  // What the last report_ready that passed declared (`data`), this conversation and app; undefined
  // before one passed. submit_for_review is judged on it, as report_ready would be now.
  let readyData: unknown = undefined;

  const reset = () => {
    verification = unverified();
    checklist = null;
    checklistData = null;
    readyData = undefined;
  };

  const missing = (declared: unknown): string[] => {
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
    out.push(...dataProblems(declared));
    return out;
  };

  // The app must not stand invented data in for the real data the user asked for without their OK.
  const dataProblems = (declared: unknown): string[] => {
    const data = dataSourceOf(declared);
    if (!data) return [DATA_REQUIRED];
    if (data === 'sample') {
      if (checklistData !== 'sample') return [SAMPLE_NOT_AGREED];
      if (!verification.sampleLabel) return [SAMPLE_LABEL_MISSING];
    }
    if (data === 'none' && checklistData === 'civitai') return [DATA_NOT_AS_PROMISED];
    return [];
  };

  const notReady = (declared: unknown, tool: string = REPORT_READY): string | null => {
    const reasons = missing(declared);
    return reasons.length ? `Not ready yet. ${reasons.join(' ')} Then call ${tool} again.` : null;
  };
  /**
   * Why submit_for_review may not run: exactly what refuses report_ready, judged on the `data` the
   * last report_ready that passed declared; before any passed, that report_ready is missing.
   */
  const submitRefusal = (): string | null =>
    readyData === undefined ? SUBMIT_NEEDS_READY : notReady(readyData, SUBMIT_FOR_REVIEW);
  /** A check-reading call made beside another call of its step that has not returned. */
  const runningRefusal = (tool: string): string | null =>
    running > 0
      ? `Call ${tool} on its own, once your other tool calls have returned: they can still change the app.`
      : null;
  let submitOffers = 0;
  const manifestRefusal = async (tool: string): Promise<string | null> => {
    const scopes = (await unjustifiedScopes?.()) ?? [];
    return scopes.length ? unjustifiedScopesRefusal(scopes, tool) : null;
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
    if (appOpen !== null && appOpen !== chosenApps.get(context.conversationId)) {
      if (changesApp(name, input)) return { refuse: openAppNotChosen(appOpen) };
      // Submitting sends the open app as the user: only a chat that made or chose it may.
      if (name === SUBMIT_FOR_REVIEW) return { refuse: submitNotChosen(appOpen) };
    }
    if (READS_CHECKS.has(name)) {
      const refusal =
        name === SUBMIT_FOR_REVIEW
          ? submitRefusal()
          : notReady((input as { data?: unknown } | null)?.data);
      if (refusal) return { refuse: refusal };
    } else running++;
    return { allow: true };
  };

  /** What a finished call says about the checks; the checklist is set by `set_checklist` itself. */
  const verify = ({ name, input, output, isError }: ToolResult) => {
    if (name === PREVIEW_CHECK) {
      verification.preview = isError ? 'error' : previewVerdictOf(output) ?? 'unreadable';
      verification.sampleLabel = !isError && showsSampleDataLabel(output);
    } else if (name === RUN_COMMAND) {
      const kind = checkKindOf((input as { command?: unknown } | null)?.command);
      // Any other command may have changed files (sed, a scaffold, npm install).
      if (kind) verification[kind] = !isError && exitCodeOf(output) === 0;
      else verification = unverified();
    } else if (name.startsWith(SANDBOX_PREFIX) && !KEEPS_CHECKS.has(name))
      verification = unverified();
  };

  const onToolResult = (result: ToolResult) => {
    const { name, refused, stopped } = result;
    // Neither ran. One its ended reply did not run stays counted in `running`; the next reply starts at 0.
    if (refused !== undefined || stopped) return;
    if (!READS_CHECKS.has(name)) running = Math.max(0, running - 1);
    choose(result);
    verify(result);
    noteReady(result);
  };

  /** A report_ready that passed: what it declared is what submit_for_review is judged on. */
  const noteReady = ({ name, output, isError, subagent }: ToolResult) => {
    if (name !== REPORT_READY || isError || subagent !== undefined) return;
    const shown = output as { ready?: unknown; data?: unknown } | null | undefined;
    if (shown?.ready === true) readyData = shown.data;
  };

  /** The checklist a successful `set_checklist` call left. */
  const checklistOf = ({ name, input, isError, refused, stopped }: ToolResult) =>
    name === SET_CHECKLIST && !isError && refused === undefined && !stopped
      ? normalizeChecklist((input as { items?: unknown } | null)?.items)
      : null;

  /** Takes up the checklist, and what it said about the data, a successful `set_checklist` left. */
  const adoptChecklist = (result: ToolResult) => {
    const items = checklistOf(result);
    if (!items) return;
    checklist = items;
    const data = (result.input as { data?: unknown } | null)?.data;
    if (data !== undefined) checklistData = dataSourceOf(data);
  };

  const set_checklist: AssistantTool = {
    description:
      "Show the user the list of features they asked for, as a checklist that is your build plan. Call it before you scaffold, with every requested feature and nothing they did not ask for, then go straight on to building it: do not wait for the user to confirm the list. Call it again with done: true on an item once it works and has a passing test. Set data: 'civitai' when the app shows Civitai data, and 'sample' only once the user agreed to sample data: the card then tells them it is not real Civitai data and your reply ends there, so they can confirm it or say what to change.",
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
        data: { type: 'string', enum: [...DATA_SOURCES] },
      },
      required: ['items'],
    },
    execute(input) {
      const items = normalizeChecklist(input.items);
      if (!items)
        throw new Error(
          `items must be an array of 1-${CHECKLIST_MAX_ITEMS} { label, done } objects, each label 1-${CHECKLIST_LABEL_MAX} characters.`
        );
      // Left out, it stays what the list last said, so ticking items off does not show the list again.
      const data = input.data === undefined ? checklistData : dataSourceOf(input.data);
      if (input.data !== undefined && !data)
        throw new Error(`data must be one of ${DATA_SOURCES.join(', ')}.`);
      // Against the last checklist this gate knows: on the runner, `restore` seeds it from the
      // conversation's earlier replies; the page knows only this page load's. Marking items done is
      // progress, not a new list.
      const previous = checklist;
      // Sample data is the user's to agree to, so a list newly saying it ends the reply for their answer.
      const newlySample = data === 'sample' && checklistData !== 'sample';
      checklist = items;
      checklistData = data;
      const tag = checklistApp ? { app: checklistApp() } : {};
      if (newlySample)
        return {
          shown: true,
          awaitsUser: true,
          note: 'The user now sees this list and that the app would show sample data, not real Civitai data. Your reply ends here: wait for them to agree or say what to change.',
          ...tag,
        };
      // The first list is the plan the user watches being built: the reply goes straight on to build it.
      if (!previous)
        return {
          shown: true,
          note: 'The user now sees this list as your plan. Go straight on to building it, and tick each item off as it works.',
          ...tag,
        };
      return { updated: true, open: items.filter((item) => !item.done).length, ...tag };
    },
  };

  const report_ready: AssistantTool = {
    description:
      "Call this on its own, before you tell the user the app is ready, every time. It is refused until, since your last file change or other command (including dev_server_start or dev_server_restart), sandbox__preview_check said render: ok, cd <blockId> && npm test and cd <blockId> && npx tsc --noEmit each exited 0 (run on their own, unpiped), and every set_checklist item is done. data says where what the app shows comes from: 'civitai', 'sample' (made-up data, only once the user agreed through set_checklist and the app shows a visible \"Sample data\" label) or 'none'. When it is refused, do what it says; never tell the user the app is ready without it.",
    activity: 'Checking the app is ready…',
    inputSchema: {
      properties: { data: { type: 'string', enum: [...DATA_SOURCES] } },
      required: ['data'],
    },
    async execute(input) {
      await letStepCallsReachGate();
      const refusal =
        runningRefusal(REPORT_READY) ??
        notReady(input.data) ??
        (await manifestRefusal(REPORT_READY));
      if (refusal) throw new Error(refusal);
      const data = dataSourceOf(input.data);
      return {
        ready: true,
        data,
        note:
          data === 'sample'
            ? 'Tell the user the app is ready for review, that it shows sample data, not real Civitai data, and what was checked: the preview check, the tests, the typecheck and each checklist item. The user sees a card saying these checks passed and that the data is sample data. If they want it in the App Store, call submit_for_review when they ask.'
            : 'Tell the user the app is ready for review, and what was checked: the preview check, the tests, the typecheck and each checklist item. The user sees a card saying these checks passed. If they want it in the App Store, call submit_for_review when they ask.',
      };
    },
  };

  const submit_for_review = createSubmitTool({
    refusal: async () =>
      runningRefusal(SUBMIT_FOR_REVIEW) ??
      submitRefusal() ??
      (await manifestRefusal(SUBMIT_FOR_REVIEW)),
    nextId: () => `${checklistPrefix}-submit-${++submitOffers}`,
  });

  return {
    reset,
    beforeToolCall,
    onToolResult,
    tools: {
      [SET_CHECKLIST]: set_checklist,
      [REPORT_READY]: report_ready,
      [SUBMIT_FOR_REVIEW]: submit_for_review,
    },
    restore({ conversationId: id, earlier, current, app = null }) {
      conversationId = id;
      reset();
      chosenApps.delete(id);
      chosenLive.delete(id);
      for (const result of [...earlier, ...current]) choose(result);
      // Without app tags (the page), every checklist counts, as it did before.
      const forThisApp = (result: ToolResult) =>
        !checklistApp || (result.output as { app?: unknown } | null)?.app === app;
      for (const result of earlier) if (forThisApp(result)) adoptChecklist(result);
      for (const result of current) {
        if (opensOtherApp(result, app)) {
          reset();
          continue;
        }
        if (forThisApp(result)) adoptChecklist(result);
        if (result.refused === undefined && !result.stopped) {
          verify(result);
          noteReady(result);
        }
      }
      carriedCalls = current.filter((result) => result.subagent === undefined).length;
    },
    restoreChoice(id, result) {
      const app = chosenAppOf(result);
      if (app !== null && !chosenLive.has(id)) chosenApps.set(id, app);
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
