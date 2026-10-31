import type { ChatToolCall, ChatToolResult } from '@civitai/components-chat/civitai-chat';
import {
  REPORTER_NOTIFIED_STATUSES,
  feedbackStatusOfferOf,
  type FeedbackStatus,
  type FeedbackStatusOffer,
} from '@civitai/app-assistant';

/**
 * The card a `set_feedback_status` offer shows, on the page whichever side ran the reply. Only the
 * user's press on it changes a status, as them; the assistant cannot.
 */

/** One status change as `appFeedback.setOwnerStatus` takes it. */
export interface SetFeedbackStatusInput {
  id: number;
  appListingId: string;
  ownerStatus: FeedbackStatus;
  /** What the item's status was when read (`null` = new): civitai refuses it if it moved since. */
  expectedOwnerStatus: FeedbackStatus | null;
}

/** `changed`: the item's status moved since it was read (civitai's CONFLICT), so nothing was written. */
export type SetFeedbackStatus = (input: SetFeedbackStatusInput) => Promise<'ok' | 'changed'>;

/** `mutate` (`appFeedback.setOwnerStatus`) with civitai's CONFLICT read as `changed`. */
export function setFeedbackStatusVia(
  mutate: (input: SetFeedbackStatusInput) => Promise<unknown>
): SetFeedbackStatus {
  return async (input) => {
    try {
      await mutate(input);
      return 'ok';
    } catch (error) {
      if ((error as { data?: { code?: unknown } } | null)?.data?.code === 'CONFLICT')
        return 'changed';
      throw error;
    }
  };
}

const STATUS_WORDS: Record<FeedbackStatus, string> = {
  acknowledged: 'acknowledged',
  resolved: 'resolved',
  wont_fix: 'won’t fix',
};

export const FEEDBACK_CARD_TITLE = 'Change feedback status';
export const feedbackWhatText = (app: string, status: FeedbackStatus) =>
  `In ${app}, mark as ${STATUS_WORDS[status]}:`;
export const feedbackItemText = (item: { id: number; excerpt: string }) =>
  `#${item.id}: “${item.excerpt}”`;
export const feedbackButtonText = (offer: Pick<FeedbackStatusOffer, 'items' | 'status'>) =>
  `Mark ${offer.items.length === 1 ? 'it' : `all ${offer.items.length}`} as ${
    STATUS_WORDS[offer.status]
  }`;
export const FEEDBACK_NOTIFIES_TEXT =
  'The people who wrote this feedback are told it was marked this way.';
export const FEEDBACK_OFFER_NOT_LIVE =
  'This offer is from an earlier visit. Ask App Assistant again to change these items.';
export const feedbackDoneText = (count: number, status: FeedbackStatus) =>
  `Marked ${count} feedback item${count === 1 ? '' : 's'} as ${STATUS_WORDS[status]}.`;
export const feedbackChangedText = (ids: readonly number[]) =>
  `Not changed, because ${ids.length === 1 ? 'it' : 'they'} changed since App Assistant read ${
    ids.length === 1 ? 'it' : 'them'
  }: ${ids.map((id) => `#${id}`).join(', ')}. Ask App Assistant to read the feedback again.`;
export const feedbackFailedText = (ids: readonly number[]) =>
  `Could not change ${ids
    .map((id) => `#${id}`)
    .join(', ')} just now. Press the button to try again.`;

export interface FeedbackStatusCards {
  /** The card for a `set_feedback_status` call; the default card for one that offered nothing. */
  render(call: ChatToolCall): HTMLElement | undefined;
  /** Every finished call, as the page hears of it: an offer heard here gets a button. */
  onToolResult(result: ChatToolResult): void;
}

type Phase = 'waiting' | 'ready' | 'sending' | 'done';

interface Card {
  el: HTMLElement;
  offer: FeedbackStatusOffer;
  phase: Phase;
  /** The items still to change: all of them, then those a failed press left. */
  pending: FeedbackStatusOffer['items'];
}

const CARD_STYLE =
  'border:1px solid var(--civitai-color-border, #8884);border-radius:8px;padding:8px 12px;margin:4px 0';
const BUTTON_STYLE =
  'min-height:44px;margin-top:8px;padding:0 16px;border-radius:6px;border:0;cursor:pointer;font:inherit;font-weight:600;color:#fff;background:var(--civitai-color-primary, #228be6)';

/**
 * The status-change cards. Only an offer this page heard of as it was made (`onToolResult`) gets a
 * button: one shown again from a saved chat says to ask again. Each press writes, as the user, the
 * items the offer names, each only if its status is still what the assistant read.
 */
export function createFeedbackStatusCards({
  setStatus,
}: {
  setStatus: SetFeedbackStatus;
}): FeedbackStatusCards {
  const cards = new Map<string, Card>();
  const live = new Set<string>();

  const line = (text: string, role: 'status' | 'alert' | null = null) => {
    const el = document.createElement('div');
    el.textContent = text;
    if (role) el.setAttribute('role', role);
    return el;
  };

  const show = (card: Card, ...children: HTMLElement[]) => {
    const title = document.createElement('div');
    title.textContent = FEEDBACK_CARD_TITLE;
    title.style.fontWeight = '600';
    // What is being marked, in the words its writers used: the user approves the items, not ids.
    // textContent only: the excerpts are other people's text.
    const what = line(feedbackWhatText(card.offer.app, card.offer.status));
    what.setAttribute('data-testid', 'app-assistant-feedback-status-what');
    const list = document.createElement('ul');
    list.style.cssText = 'margin:4px 0 0;padding-left:18px';
    list.setAttribute('data-testid', 'app-assistant-feedback-status-items');
    for (const item of card.offer.items) {
      const row = document.createElement('li');
      row.textContent = feedbackItemText(item);
      list.append(row);
    }
    card.el.replaceChildren(title, what, list, ...children);
  };

  const offerButton = (card: Card, ...notes: HTMLElement[]) => {
    card.phase = 'ready';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = feedbackButtonText(card.offer);
    button.style.cssText = BUTTON_STYLE;
    button.addEventListener('click', () => void press(card, button));
    const notify = REPORTER_NOTIFIED_STATUSES.includes(card.offer.status)
      ? [line(FEEDBACK_NOTIFIES_TEXT)]
      : [];
    show(card, ...notify, ...notes, button);
  };

  const press = async (card: Card, button: HTMLButtonElement) => {
    if (card.phase !== 'ready') return;
    card.phase = 'sending';
    button.disabled = true;
    button.textContent = 'Saving…';
    const { appListingId, status } = card.offer;
    const done: number[] = [];
    const changed: number[] = [];
    const failed: FeedbackStatusOffer['items'] = [];
    // One at a time: each is its own conditional write, and a failure leaves the rest to retry.
    for (const item of card.pending) {
      try {
        const outcome = await setStatus({
          id: item.id,
          appListingId,
          ownerStatus: status,
          expectedOwnerStatus: item.from === 'new' ? null : item.from,
        });
        (outcome === 'ok' ? done : changed).push(item.id);
      } catch {
        failed.push(item);
      }
    }
    const notes = [
      ...(done.length ? [line(feedbackDoneText(done.length, status), 'status')] : []),
      ...(changed.length ? [line(feedbackChangedText(changed), 'alert')] : []),
    ];
    if (failed.length) {
      card.pending = failed;
      offerButton(card, ...notes, line(feedbackFailedText(failed.map((item) => item.id)), 'alert'));
      return;
    }
    card.phase = 'done';
    card.pending = [];
    show(card, ...notes);
  };

  const cardFor = (offer: FeedbackStatusOffer) => {
    let card = cards.get(offer.feedbackStatus);
    if (card) return card;
    const el = document.createElement('div');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', FEEDBACK_CARD_TITLE);
    el.style.cssText = CARD_STYLE;
    card = { el, offer, phase: 'waiting', pending: [...offer.items] };
    cards.set(offer.feedbackStatus, card);
    if (live.has(offer.feedbackStatus)) offerButton(card);
    else show(card, line(FEEDBACK_OFFER_NOT_LIVE));
    return card;
  };

  return {
    render(call) {
      if (call.state !== 'done') return undefined;
      const offer = feedbackStatusOfferOf({
        name: call.name,
        input: call.input,
        output: call.output,
        isError: false,
      });
      return offer ? cardFor(offer).el : undefined;
    },
    onToolResult(result) {
      const offer = feedbackStatusOfferOf(result);
      if (!offer) return;
      live.add(offer.feedbackStatus);
      const card = cards.get(offer.feedbackStatus);
      if (card?.phase === 'waiting') offerButton(card);
    },
  };
}
