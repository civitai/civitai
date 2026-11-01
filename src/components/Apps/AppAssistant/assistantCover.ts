import type { ChatToolCall, ChatToolResult } from '@civitai/components-chat/civitai-chat';
import {
  CoverPriceRoseError,
  coverErrorMessage,
  coverOfferOf,
  type CoverOffer,
} from '@civitai/app-assistant';
import {
  BUTTON_STYLE,
  CARD_STYLE,
  SECONDARY_STYLE,
  line,
} from '~/components/Apps/AppAssistant/assistantCards';

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

// The cover card has two buttons side by side.
const OFFER_BUTTON_STYLE = `${BUTTON_STYLE};margin-right:8px`;

/**
 * The cover offer cards. A press runs once: the button goes as it is pressed, and nothing on the card
 * can start a second run. A press that finds a higher price makes nothing: the card asks again at
 * that price.
 *
 * While a cover is being made the page asks before it unloads (`beforeunload`). If the user leaves
 * anyway, `pagehide` aborts the press: nothing is submitted if it is still reading the listing or
 * the price, and a submitted run is sent a cancel. That cancel is an ordinary request (the SDK's
 * client takes no `keepalive`), so a page that is already unloading may drop it, and the run then
 * finishes and is billed.
 */
export function createCoverCards({ make }: { make: MakeOfferedCover }): CoverCards {
  const cards = new Map<string, Card>();
  const live = new Set<string>();

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

  /** Buttons for the card's offer at its price; `notice` first, when there is something to say. */
  const offerButtons = (card: Card, notice?: string) => {
    card.phase = 'ready';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.textContent = coverButtonText(card.offer);
    yes.style.cssText = OFFER_BUTTON_STYLE;
    yes.addEventListener('click', () => void press(card));
    const no = document.createElement('button');
    no.type = 'button';
    no.textContent = COVER_DECLINE_TEXT;
    no.style.cssText = SECONDARY_STYLE;
    no.addEventListener('click', () => decline(card));
    show(card, ...(notice ? [line(notice, 'alert')] : []), yes, no);
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
    // Asks before the page unloads, as leaving mid-run may not stop the run (see above).
    const ask = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('pagehide', leave, { once: true });
    window.addEventListener('beforeunload', ask);
    try {
      const said = await make(card.offer, stop.signal);
      card.phase = 'done';
      show(card, line(said, 'status'));
    } catch (error) {
      if (error instanceof CoverPriceRoseError) {
        // Nothing was generated. Offered again at the new price, which only a press accepts.
        card.offer = { ...card.offer, buzz: error.buzz };
        offerButtons(card, coverErrorMessage(error));
        return;
      }
      // Never offered again: a failed press says why, and a new cover is asked for afresh.
      card.phase = 'done';
      show(card, line(coverErrorMessage(error), 'alert'));
    } finally {
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('beforeunload', ask);
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
