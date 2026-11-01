import type { ChatToolCall, ChatToolResult } from '@civitai/components-chat/civitai-chat';
import { coverErrorMessage, coverOfferOf, type CoverOffer } from '@civitai/app-assistant';

/**
 * The card a `generate_app_cover` offer shows; its press is the one that makes the cover (the rule:
 * `@civitai/app-assistant`'s `cover.ts`). Same plumbing as the feedback status card
 * (`assistantFeedback.ts`): a button only for an offer this page heard of live, none for one shown
 * again from a saved chat.
 */

/** Makes the cover `offer` names, as the user; resolves with what they are told, throws for them. */
export type MakeOfferedCover = (offer: CoverOffer, signal: AbortSignal) => Promise<string>;

export const COVER_CARD_TITLE = 'Store cover';
export const coverQuestionText = (offer: Pick<CoverOffer, 'app' | 'buzz'>) =>
  `Generate a cover for ${offer.app} for ~${offer.buzz} Buzz?`;
export const coverPromptText = (offer: Pick<CoverOffer, 'prompt'>) => `It shows: “${offer.prompt}”`;
export const coverButtonText = (offer: Pick<CoverOffer, 'buzz'>) =>
  `Generate cover (~${offer.buzz} Buzz)`;
export const COVER_DECLINE_TEXT = 'Not now';
export const COVER_DECLINED =
  'No cover was generated. Ask App Assistant again whenever you want one.';
export const COVER_MAKING = 'Generating your cover…';
export const COVER_OFFER_NOT_LIVE =
  'This offer is from an earlier visit. Ask App Assistant again for a cover.';

export interface CoverCards {
  /** The card for a `generate_app_cover` call; the default card for one that offered nothing. */
  render(call: ChatToolCall): HTMLElement | undefined;
  /** Every finished call, as the page hears of it: an offer heard here gets a button. */
  onToolResult(result: ChatToolResult): void;
}

type Phase = 'waiting' | 'ready' | 'making' | 'done';

interface Card {
  el: HTMLElement;
  offer: CoverOffer;
  phase: Phase;
}

const CARD_STYLE =
  'border:1px solid var(--civitai-color-border, #8884);border-radius:8px;padding:8px 12px;margin:4px 0';
const BUTTON_STYLE =
  'min-height:44px;margin-top:8px;margin-right:8px;padding:0 16px;border-radius:6px;border:0;cursor:pointer;font:inherit;font-weight:600;color:#fff;background:var(--civitai-color-primary, #228be6)';
const SECONDARY_STYLE =
  'min-height:44px;margin-top:8px;padding:0 16px;border-radius:6px;border:1px solid var(--civitai-color-border, #8884);cursor:pointer;font:inherit;background:transparent;color:inherit';

/**
 * The cover offer cards. A press runs once: the button goes as it is pressed, and nothing on the card
 * can start a second run. Leaving the page while a cover is made stops it (its run is cancelled).
 */
export function createCoverCards({ make }: { make: MakeOfferedCover }): CoverCards {
  const cards = new Map<string, Card>();
  const live = new Set<string>();

  const line = (text: string, role: 'status' | 'alert' | null = null) => {
    const el = document.createElement('div');
    el.textContent = text;
    if (role) el.setAttribute('role', role);
    return el;
  };

  // textContent only: the prompt is the assistant's text.
  const show = (card: Card, ...children: HTMLElement[]) => {
    const title = document.createElement('div');
    title.textContent = COVER_CARD_TITLE;
    title.style.fontWeight = '600';
    const question = line(coverQuestionText(card.offer));
    question.setAttribute('data-testid', 'app-assistant-cover-question');
    const prompt = line(coverPromptText(card.offer));
    prompt.style.opacity = '0.8';
    card.el.replaceChildren(title, question, prompt, ...children);
  };

  const offerButtons = (card: Card) => {
    card.phase = 'ready';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.textContent = coverButtonText(card.offer);
    yes.style.cssText = BUTTON_STYLE;
    yes.addEventListener('click', () => void press(card));
    const no = document.createElement('button');
    no.type = 'button';
    no.textContent = COVER_DECLINE_TEXT;
    no.style.cssText = SECONDARY_STYLE;
    no.addEventListener('click', () => decline(card));
    show(card, yes, no);
  };

  const decline = (card: Card) => {
    if (card.phase !== 'ready') return;
    card.phase = 'done';
    show(card, line(COVER_DECLINED, 'status'));
  };

  const press = async (card: Card) => {
    // Once: a second click, or a click on a card already used, starts nothing.
    if (card.phase !== 'ready') return;
    card.phase = 'making';
    show(card, line(COVER_MAKING, 'status'));
    const stop = new AbortController();
    const leave = () => stop.abort();
    window.addEventListener('pagehide', leave, { once: true });
    try {
      const said = await make(card.offer, stop.signal);
      show(card, line(said, 'status'));
    } catch (error) {
      show(card, line(coverErrorMessage(error), 'alert'));
    } finally {
      window.removeEventListener('pagehide', leave);
      // Never offered again: a failed press says why, and a new cover is asked for afresh.
      card.phase = 'done';
    }
  };

  const cardFor = (offer: CoverOffer) => {
    let card = cards.get(offer.coverOffer);
    if (card) return card;
    const el = document.createElement('div');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', COVER_CARD_TITLE);
    el.setAttribute('data-testid', 'app-assistant-cover-card');
    el.style.cssText = CARD_STYLE;
    card = { el, offer, phase: 'waiting' };
    cards.set(offer.coverOffer, card);
    if (live.has(offer.coverOffer)) offerButtons(card);
    else show(card, line(COVER_OFFER_NOT_LIVE));
    return card;
  };

  return {
    render(call) {
      if (call.state !== 'done') return undefined;
      const offer = coverOfferOf({
        name: call.name,
        input: call.input,
        output: call.output,
        isError: false,
      });
      return offer ? cardFor(offer).el : undefined;
    },
    onToolResult(result) {
      const offer = coverOfferOf(result);
      if (!offer) return;
      live.add(offer.coverOffer);
      const card = cards.get(offer.coverOffer);
      if (card?.phase === 'waiting') offerButtons(card);
    },
  };
}
