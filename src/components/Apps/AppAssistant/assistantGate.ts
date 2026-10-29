import type {
  ChatTool,
  ChatToolCall,
  ChatToolGate,
  ChatToolResult,
} from '@civitai/components-chat/civitai-chat';
import {
  REPORT_READY,
  SET_CHECKLIST,
  createGateCore,
  normalizeChecklist,
} from '@civitai/app-assistant';

// The gate's rules live in `@civitai/app-assistant`, so the server runner applies the same ones; the
// page adds what only it can do: the checklist and ready cards, and Build it.
export {
  APP_ASSISTANT_TURN_TOOL_CALL_LIMIT,
  BUILD_IT_MESSAGE,
  REPORT_READY,
  SANDBOX_SERVER_ID,
  SET_CHECKLIST,
  TURN_LIMIT_MESSAGE,
  TURN_LIMIT_REFUSAL,
  checkKindOf,
  exitCodeOf,
  normalizeChecklist,
  previewVerdictOf,
} from '@civitai/app-assistant';
export type { CheckKind, ChecklistItem, DataSource } from '@civitai/app-assistant';

export interface AssistantGate {
  /** Forget what was verified, e.g. when another sandbox opens. */
  reset(): void;
  /** The user answered the checklist another way (sent a message, opened another chat): remove Build it. */
  answered(): void;
  /** Another app opened: a checklist shown for a different one loses its Build it. */
  appChanged(app: string | null): void;
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
  currentApp,
}: {
  /** The page's own refusal for a call, if any; counted against the per-reply limit like any call. */
  refuse?: (name: string) => string | null;
  /** Told when a new reply makes its first tool call, before that call's refusal is asked. */
  onReply?: () => void;
  /** The user pressed Build it under a checklist that waits for them. */
  onBuild?: () => void;
  /** The app open now; a checklist belongs to the app it was shown for. */
  currentApp?: () => string | null;
} = {}): AssistantGate {
  let buildButtons: HTMLButtonElement[] = [];
  const removeButtons = () => {
    for (const button of buildButtons) button.remove();
    buildButtons = [];
  };
  // Checklist ids are per page load, so a card restored from an earlier visit never matches.
  const core = createGateCore({
    refuse,
    onReply: () => {
      removeButtons();
      onReply?.();
    },
    currentApp,
  });

  const answered = () => {
    core.clearAwaiting();
    removeButtons();
  };

  const set_checklist: ChatTool = {
    ...core.tools[SET_CHECKLIST],
    render(call) {
      const card = renderChecklist(call);
      const shownAs = (call.output as { checklist?: unknown } | null | undefined)?.checklist;
      const awaiting = core.awaiting();
      if (!card || !onBuild || !awaiting || shownAs !== awaiting.id) return card;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Build it';
      button.style.cssText =
        'min-height:44px;margin-top:8px;padding:0 16px;border-radius:6px;border:0;cursor:pointer;font:inherit;font-weight:600;color:#fff;background:var(--civitai-color-primary, #228be6)';
      // The page removes it (`answered`) once the message goes, or once it puts it in the message box.
      button.addEventListener('click', onBuild);
      buildButtons.push(button);
      card.append(button);
      return card;
    },
  };

  const report_ready: ChatTool = { ...core.tools[REPORT_READY], render: renderReady };

  return {
    reset: core.reset,
    answered,
    appChanged: (app) => {
      const awaiting = core.awaiting();
      if (awaiting && app !== awaiting.app) answered();
    },
    beforeToolCall: core.beforeToolCall,
    onToolResult: core.onToolResult,
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
  if ((call.input as { data?: unknown } | null)?.data === 'sample') {
    const note = document.createElement('div');
    note.textContent = CHECKLIST_SAMPLE_DATA_TEXT;
    note.style.cssText = 'margin-top:4px;font-weight:600';
    card.append(note);
  }
  return card;
}

/** What a checklist that plans sample data tells the user, so Build it is their agreement to it. */
export const CHECKLIST_SAMPLE_DATA_TEXT =
  '⚠ Sample data: this app will show made-up examples, not real Civitai data.';

/**
 * What a passing report_ready's card says was checked. `sandbox__preview_check` loads the app in a
 * headless browser in the sandbox (a stand-in for civitai.com), not the user's live preview.
 */
export const READY_CARD_TEXT =
  '✓ Checked: the app renders in a test browser, the tests and the typecheck pass, and every checklist item is done.';
/** Added to {@link READY_CARD_TEXT} when the app shows sample data. */
export const READY_CARD_SAMPLE_DATA_TEXT = ' ⚠ This app shows sample data, not real Civitai data.';

/** The card a passing report_ready shows: the user's sign that the checks ran. The default card otherwise. */
export function renderReady(call: ChatToolCall): HTMLElement | undefined {
  if (call.state !== 'done' || (call.output as { ready?: unknown } | null)?.ready !== true)
    return undefined;
  const card = document.createElement('div');
  card.setAttribute('role', 'status');
  card.style.cssText =
    'border:1px solid var(--civitai-color-border, #8884);border-radius:8px;padding:8px 12px;margin:4px 0';
  card.textContent =
    (call.output as { data?: unknown }).data === 'sample'
      ? READY_CARD_TEXT + READY_CARD_SAMPLE_DATA_TEXT
      : READY_CARD_TEXT;
  return card;
}
