import type {
  ChatTool,
  ChatToolCall,
  ChatToolGate,
  ChatToolResult,
} from '@civitai/components-chat/civitai-chat';
import {
  CREATE_APP,
  GENERATE_APP_COVER,
  REPORT_READY,
  SET_FEEDBACK_STATUS,
  SET_CHECKLIST,
  SUBMIT_FOR_REVIEW,
  USE_OPEN_APP,
  createCoverArt,
  createFeedbackTools,
  createGateCore,
  makeOfferedCover,
  normalizeChecklist,
  type AppFeedbackSource,
  type CoverArtDeps,
  type CoverPressDeps,
} from '@civitai/app-assistant';
import { createCoverCards } from '~/components/Apps/AppAssistant/assistantCover';
import type { SetFeedbackStatus } from '~/components/Apps/AppAssistant/assistantFeedback';
import { createFeedbackStatusCards } from '~/components/Apps/AppAssistant/assistantFeedback';
import type { SubmitCardsDeps } from '~/components/Apps/AppAssistant/assistantSubmit';
import { createSubmitCards } from '~/components/Apps/AppAssistant/assistantSubmit';

// The gate's rules live in `@civitai/app-assistant`, so the server runner applies the same ones; the
// page adds what only it can do: the checklist, ready, Submit for review and feedback status cards.
export {
  APP_ASSISTANT_TURN_TOOL_CALL_LIMIT,
  REPORT_READY,
  SANDBOX_SERVER_ID,
  SET_CHECKLIST,
  SUBMIT_FOR_REVIEW,
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
  /** The user sent a message or opened another chat: a Submit for review offer closes. */
  answered(): void;
  /** Another app opened: a Submit for review offer made for a different one closes. */
  appChanged(app: string | null): void;
  beforeToolCall: ChatToolGate;
  onToolResult(result: ChatToolResult): void;
  tools: Record<string, ChatTool>;
  /**
   * `tools` with `create_app` and `use_open_app` telling the gate what their saved calls chose as the
   * chat shows them (`chatId`, the open chat): a reloaded or reopened chat keeps the app it made or
   * chose. The page has no other view of a saved chat's calls.
   */
  restoringChoices(
    tools: Record<string, ChatTool>,
    chatId: () => string | null
  ): Record<string, ChatTool>;
}

/**
 * The page's own checks on the assistant's tool calls: a per-reply call limit, and a `report_ready`
 * that is refused until the tool results of this conversation show the app checked.
 */
export function createAssistantGate({
  refuse,
  onReply,
  currentApp,
  submit,
  openApp,
  feedback,
  cover,
}: {
  /** The page's own refusal for a call, if any; counted against the per-reply limit like any call. */
  refuse?: (name: string) => string | null;
  /** Told when a new reply makes its first tool call, before that call's refusal is asked. */
  onReply?: () => void;
  /** The app open now; a Submit for review offer belongs to the app it was made for. */
  currentApp?: () => string | null;
  /** What the Submit for review button does; without it, a submit_for_review call shows no button. */
  submit?: SubmitCardsDeps;
  /** The open app's key: a chat may change it only once it made or chose it (`createGateCore`). */
  openApp?: () => string | null;
  /**
   * The open app's feedback: where it is read (the page's own author reads, as the user), and what
   * a press on a status card does. Without it, no feedback tools.
   */
  feedback?: { source: AppFeedbackSource; setStatus: SetFeedbackStatus };
  /**
   * The store cover: what the tool reads to offer one (the user's listing, the price), and what a
   * press on its card does (generate and attach, as the user). Without it, no cover tool.
   */
  cover?: { offer: Omit<CoverArtDeps, 'nextId'>; press: CoverPressDeps };
} = {}): AssistantGate {
  const submitCards = submit ? createSubmitCards(submit) : null;
  const feedbackCards = feedback ? createFeedbackStatusCards(feedback) : null;
  let feedbackOffers = 0;
  const feedbackPrefix = Math.random().toString(36).slice(2, 10);
  const feedbackSet = feedback
    ? createFeedbackTools({
        current: () => openApp?.() ?? null,
        source: feedback.source,
        nextId: () => `${feedbackPrefix}-feedback-${++feedbackOffers}`,
      })
    : null;
  const feedbackTools: Record<string, ChatTool> = feedbackSet?.tools ?? {};
  // The cover tool only offers; the card's press makes the cover. In runner mode the runner's own
  // tool offers, and this card (heard of through `onToolResult`) still does the press, as the user.
  let coverOffers = 0;
  const coverCards = cover
    ? createCoverCards({ make: (offer, signal) => makeOfferedCover(cover.press, offer, signal) })
    : null;
  const coverTool: ChatTool | null = cover
    ? createCoverArt({
        ...cover.offer,
        nextId: () => `${feedbackPrefix}-cover-${++coverOffers}`,
      })[GENERATE_APP_COVER]!
    : null;
  const core = createGateCore({
    refuse,
    onReply: () => {
      submitCards?.withdraw();
      // A status offer names only items read in this reply, as on the runner.
      feedbackSet?.newReply();
      onReply?.();
    },
    openApp,
  });

  const set_checklist: ChatTool = { ...core.tools[SET_CHECKLIST], render: renderChecklist };

  const report_ready: ChatTool = { ...core.tools[REPORT_READY], render: renderReady };
  const submit_for_review: ChatTool = {
    ...core.tools[SUBMIT_FOR_REVIEW],
    ...(submitCards ? { render: submitCards.render } : {}),
  };

  return {
    reset: core.reset,
    answered: () => submitCards?.withdraw(),
    appChanged: (app) => submitCards?.appChanged(app),
    beforeToolCall: core.beforeToolCall,
    onToolResult: (result) => {
      core.onToolResult(result);
      submitCards?.onToolResult(result, currentApp?.() ?? null);
      feedbackCards?.onToolResult(result);
      coverCards?.onToolResult(result);
    },
    tools: {
      [SET_CHECKLIST]: set_checklist,
      [REPORT_READY]: report_ready,
      [SUBMIT_FOR_REVIEW]: submit_for_review,
      ...feedbackTools,
      ...(feedbackCards
        ? {
            [SET_FEEDBACK_STATUS]: {
              ...feedbackTools[SET_FEEDBACK_STATUS]!,
              render: feedbackCards.render,
            },
          }
        : {}),
      ...(coverTool && coverCards
        ? { [GENERATE_APP_COVER]: { ...coverTool, render: coverCards.render } }
        : {}),
    },
    restoringChoices: (tools, chatId) => {
      const out = { ...tools };
      for (const name of [CREATE_APP, USE_OPEN_APP]) {
        const tool = tools[name];
        if (!tool) continue;
        out[name] = {
          ...tool,
          render(call) {
            const id = chatId();
            if (id !== null && call.state === 'done')
              core.restoreChoice(id, {
                name: call.name,
                input: call.input,
                output: call.output,
                isError: false,
              });
            return tool.render?.(call);
          },
        };
      }
      return out;
    },
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

/**
 * What a checklist that plans sample data tells the user. That checklist ends the reply, so the user's
 * answer is their agreement to it.
 */
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
