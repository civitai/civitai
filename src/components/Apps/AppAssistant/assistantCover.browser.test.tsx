import { describe, expect, test, vi } from 'vitest';
import type { ChatToolCall } from '@civitai/components-chat/civitai-chat';
import {
  GENERATE_APP_COVER,
  type AppCoverWorkflow,
  type CoverListing,
  type CoverOffer,
} from '@civitai/app-assistant';
import { createAssistantGate } from '~/components/Apps/AppAssistant/assistantGate';
import {
  COVER_DECLINED,
  COVER_DECLINE_TEXT,
  COVER_OFFER_NOT_LIVE,
  coverButtonText,
  coverQuestionText,
} from '~/components/Apps/AppAssistant/assistantCover';

/**
 * The store cover card: `generate_app_cover` only offers a cover with its price, and only the user's
 * press on its card generates and attaches it, once. Whichever side ran the reply: the runner's
 * offer reaches the page as a reported result, and the card does the press here.
 */

const APP = 'tip-calc';
// Pairwise distinct: the price is no seed, id or count used here.
const PRICE = 23;
const LISTING: CoverListing = { listingId: 'apl_own_61', blockedReason: null, status: 'draft' };
const IMAGE_URL = 'https://orchestration.example/blobs/card.jpeg';
const ctx = { signal: new AbortController().signal, conversationId: 'c', files: [] };
const conv = { conversationId: 'c', reply: 1 };

function setup() {
  const listing = vi.fn(async (_app: string): Promise<CoverListing | null> => LISTING);
  const price = vi.fn(async (_w: AppCoverWorkflow) => PRICE);
  let finish: (url: string) => void = () => undefined;
  const generate = vi.fn(
    (_w: AppCoverWorkflow, _s?: AbortSignal) => new Promise<string>((resolve) => (finish = resolve))
  );
  const attach = vi.fn(async (_id: string, _url: string, _app: string) => ({
    scanPending: false,
  }));
  const gate = createAssistantGate({
    openApp: () => APP,
    cover: {
      offer: { currentApp: () => APP, listing, price, seed: () => 9 },
      press: { listing, generate, attach },
    },
  });
  /** Runs a call through the gate as the chat does, and tells the gate of its result. */
  const call = async (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    await gate.beforeToolCall(GENERATE_APP_COVER, input, conv);
    const output = await gate.tools[GENERATE_APP_COVER]!.execute(input, ctx);
    gate.onToolResult({ name: GENERATE_APP_COVER, input, output, isError: false, ...extra });
    return output as CoverOffer;
  };
  const render = (output: unknown) =>
    gate.tools[GENERATE_APP_COVER]!.render!({
      id: 'call-1',
      name: GENERATE_APP_COVER,
      input: {},
      output,
      state: 'done',
    } as ChatToolCall) as HTMLElement | undefined;
  return { gate, call, render, generate, attach, price, finish: (url = IMAGE_URL) => finish(url) };
}

const buttons = (card: HTMLElement) => [...card.querySelectorAll('button')];
const pressButton = (card: HTMLElement) =>
  buttons(card).find((b) => b.textContent === coverButtonText({ buzz: PRICE }));

describe('the store cover card', () => {
  test('offers the cover with its price, and generates nothing until it is pressed', async () => {
    const s = setup();
    const offer = await s.call({ prompt: 'a calculator' });
    const card = s.render(offer)!;
    expect(card.textContent).toContain(coverQuestionText({ app: APP, buzz: PRICE }));
    expect(card.textContent).toContain('Generate a cover for tip-calc for ~23 Buzz?');
    expect(pressButton(card)).toBeDefined();
    expect(s.price).toHaveBeenCalledTimes(1);
    expect(s.generate).not.toHaveBeenCalled();
    expect(s.attach).not.toHaveBeenCalled();
  });

  test('the press generates once, however often it is pressed, and attaches it', async () => {
    const s = setup();
    const card = s.render(await s.call({ prompt: 'a calculator' }))!;
    const button = pressButton(card)!;
    button.click();
    button.click();
    await vi.waitFor(() => expect(s.generate).toHaveBeenCalledTimes(1));
    // Gone while it is made: nothing on the card can start a second run.
    expect(pressButton(card)).toBeUndefined();
    s.finish();
    await vi.waitFor(() => expect(s.attach).toHaveBeenCalledTimes(1));
    expect(s.attach).toHaveBeenCalledWith(LISTING.listingId, IMAGE_URL, APP);
    expect(s.generate).toHaveBeenCalledTimes(1);
    expect(pressButton(card)).toBeUndefined();
  });

  test('a card shown again from a saved chat has no button and can never generate', async () => {
    const s = setup();
    // The same offer, as a saved chat shows it: rendered, never heard of live here.
    const saved: CoverOffer = {
      awaitsUser: true,
      coverOffer: 'from-another-visit-1',
      app: APP,
      listingId: LISTING.listingId,
      listingStatus: 'draft',
      prompt: 'a calculator',
      seed: 9,
      buzz: PRICE,
      note: 'n',
    };
    const card = s.render(saved)!;
    expect(card.textContent).toContain(COVER_OFFER_NOT_LIVE);
    expect(buttons(card)).toEqual([]);
    expect(s.generate).not.toHaveBeenCalled();
  });

  test('declined: nothing is generated, and the card offers nothing more', async () => {
    const s = setup();
    const card = s.render(await s.call({ prompt: 'a calculator' }))!;
    buttons(card)
      .find((b) => b.textContent === COVER_DECLINE_TEXT)!
      .click();
    await vi.waitFor(() => expect(card.textContent).toContain(COVER_DECLINED));
    expect(buttons(card)).toEqual([]);
    expect(s.generate).not.toHaveBeenCalled();
    expect(s.attach).not.toHaveBeenCalled();
  });

  test('a subagent’s offer gets no button', async () => {
    const s = setup();
    const offer = await s.call({ prompt: 'a calculator' }, { subagent: 'dispatch-1' });
    const card = s.render(offer)!;
    expect(buttons(card)).toEqual([]);
    expect(s.generate).not.toHaveBeenCalled();
  });

  test('a runner’s offer, reported to the page, gets the button and the press runs here', async () => {
    const s = setup();
    // The runner priced and offered it: the page hears of it only as a reported result.
    const fromRunner: CoverOffer = {
      awaitsUser: true,
      coverOffer: 'run-7-cover-1',
      app: APP,
      listingId: LISTING.listingId,
      listingStatus: 'draft',
      prompt: 'a runner cover',
      seed: 5,
      buzz: PRICE,
      note: 'n',
    };
    s.gate.onToolResult({
      name: GENERATE_APP_COVER,
      input: {},
      output: fromRunner,
      isError: false,
    });
    const card = s.render(fromRunner)!;
    expect(s.generate).not.toHaveBeenCalled();
    pressButton(card)!.click();
    await vi.waitFor(() => expect(s.generate).toHaveBeenCalledTimes(1));
    expect(s.generate.mock.calls[0]![0]).toMatchObject({ externalId: 'app-cover-run-7-cover-1' });
    expect(s.generate.mock.calls[0]![0].steps[0].input).toMatchObject({
      prompt: 'a runner cover',
      seed: 5,
    });
  });
});
