import { describe, expect, test, vi } from 'vitest';
import type { ChatToolCall } from '@civitai/components-chat/civitai-chat';
import {
  COVER_PRICE_UNCHECKED,
  GENERATE_APP_COVER,
  coverPriceRose,
  generateCover,
  type CoverOrchestration,
  type AppCoverWorkflow,
  type CoverListing,
  type CoverOffer,
} from '@civitai/app-assistant';
import { createAssistantGate } from '~/components/Apps/AppAssistant/assistantGate';
import {
  COVER_MAKING as COVER_MAKING_TEXT,
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
  // The offer's listing read and the press's are separate, so "no press started" is observable: a
  // press reads the listing before anything else, synchronously from the click.
  const offerListing = vi.fn(async (_app: string): Promise<CoverListing | null> => LISTING);
  const pressListing = vi.fn(async (_app: string): Promise<CoverListing | null> => LISTING);
  const price = vi.fn(async (_w: AppCoverWorkflow) => PRICE);
  // The re-quote at the press; separate from the offer's so a case can move the price between.
  const pressPrice = vi.fn(async (_w: AppCoverWorkflow) => PRICE);
  let finish: (url: string) => void = () => undefined;
  // Held until `finish`, or until the press is aborted (a `pagehide`), as a real run's wait is.
  const generate = vi.fn(
    (_w: AppCoverWorkflow, signal?: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        finish = resolve;
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })
  );
  const attach = vi.fn(async (_id: string, _url: string, _app: string) => ({
    scanPending: false,
  }));
  const gate = createAssistantGate({
    openApp: () => APP,
    cover: {
      offer: { currentApp: () => APP, listing: offerListing, price, seed: () => 9 },
      press: { listing: pressListing, price: pressPrice, generate, attach },
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
  return {
    gate,
    call,
    render,
    offerListing,
    pressListing,
    pressPrice,
    generate,
    attach,
    price,
    finish: (url = IMAGE_URL) => finish(url),
  };
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
    // The offer read the listing and the card shows its button. A press reads the listing first,
    // synchronously from the click (the runner case below shows that read is seen), so none here
    // means no press started.
    await vi.waitFor(() => expect(s.offerListing).toHaveBeenCalledTimes(1));
    expect(s.pressListing).not.toHaveBeenCalled();
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
    // Settled: the offer read the listing and the card is drawn, so no button is final.
    await vi.waitFor(() => expect(s.offerListing).toHaveBeenCalledTimes(1));
    expect(card.textContent).toContain(COVER_OFFER_NOT_LIVE);
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
    expect(pressButton(card)).toBeDefined();
    expect(s.pressListing).not.toHaveBeenCalled();
    expect(s.generate).not.toHaveBeenCalled();
    pressButton(card)!.click();
    expect(s.pressListing).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(s.generate).toHaveBeenCalledTimes(1));
    expect(s.generate.mock.calls[0]![0]).toMatchObject({ externalId: 'app-cover-run-7-cover-1' });
    expect(s.generate.mock.calls[0]![0].steps[0].input).toMatchObject({
      prompt: 'a runner cover',
      seed: 5,
    });
  });

  test('a price that rose since the offer generates nothing until the new price is pressed', async () => {
    const s = setup();
    const risen = PRICE + 6;
    s.pressPrice.mockResolvedValue(risen);
    const card = s.render(await s.call({ prompt: 'a calculator' }))!;
    pressButton(card)!.click();
    // The card now asks at the new price, with a button for it, and nothing was generated.
    await vi.waitFor(() =>
      expect(card.textContent).toContain(coverQuestionText({ app: APP, buzz: risen }))
    );
    expect(card.textContent).toContain(coverPriceRose(risen));
    expect(s.generate).not.toHaveBeenCalled();
    const again = buttons(card).find((b) => b.textContent === coverButtonText({ buzz: risen }));
    expect(again).toBeDefined();
    again!.click();
    await vi.waitFor(() => expect(s.generate).toHaveBeenCalledTimes(1));
    expect(s.pressPrice).toHaveBeenCalledTimes(2);
  });

  test('a price that is the same or lower at the press generates on the first press', async () => {
    const s = setup();
    s.pressPrice.mockResolvedValue(PRICE - 4);
    const card = s.render(await s.call({ prompt: 'a calculator' }))!;
    pressButton(card)!.click();
    await vi.waitFor(() => expect(s.generate).toHaveBeenCalledTimes(1));
  });

  test('a press whose price cannot be checked generates nothing and says so', async () => {
    const s = setup();
    s.pressPrice.mockRejectedValue(new Error('orchestration down'));
    const card = s.render(await s.call({ prompt: 'a calculator' }))!;
    pressButton(card)!.click();
    await vi.waitFor(() => expect(card.textContent).toContain(COVER_PRICE_UNCHECKED));
    expect(s.generate).not.toHaveBeenCalled();
  });

  describe('leaving the page', () => {
    const leave = () => window.dispatchEvent(new PageTransitionEvent('pagehide'));

    /** A gate whose press really runs `generateCover` on `orchestration`, as the page's does. */
    function withOrchestration(
      orchestration: CoverOrchestration,
      pressPrice: (w: AppCoverWorkflow) => Promise<number> = async () => PRICE
    ) {
      const listing = vi.fn(async (_app: string): Promise<CoverListing | null> => LISTING);
      const gate = createAssistantGate({
        openApp: () => APP,
        cover: {
          offer: { currentApp: () => APP, listing, price: async () => PRICE, seed: () => 9 },
          press: {
            listing,
            price: pressPrice,
            generate: (workflow, signal) => generateCover(orchestration, workflow, signal),
            attach: async () => ({ scanPending: false }),
          },
        },
      });
      const open = async () => {
        const input = { prompt: 'a calculator' };
        await gate.beforeToolCall(GENERATE_APP_COVER, input, conv);
        const output = await gate.tools[GENERATE_APP_COVER]!.execute(input, ctx);
        gate.onToolResult({ name: GENERATE_APP_COVER, input, output, isError: false });
        return gate.tools[GENERATE_APP_COVER]!.render!({
          id: 'call-leave',
          name: GENERATE_APP_COVER,
          input: {},
          output,
          state: 'done',
        } as ChatToolCall) as HTMLElement;
      };
      return { open };
    }

    /** An orchestration whose wait holds until its signal aborts. */
    function holdingOrchestration() {
      return {
        submitWorkflow: vi.fn(async () => ({ id: 'wf_leave', status: 'submitted' })),
        waitForWorkflow: vi.fn(
          (_id: string, opts?: { signal?: AbortSignal }) =>
            new Promise<never>((_resolve, reject) =>
              opts?.signal?.addEventListener('abort', () =>
                reject(new DOMException('Aborted', 'AbortError'))
              )
            )
        ),
        cancelWorkflow: vi.fn(async () => undefined),
      };
    }

    test('leaving while the cover is generated cancels its run', async () => {
      const orchestration = holdingOrchestration();
      const card = await withOrchestration(orchestration).open();
      pressButton(card)!.click();
      await vi.waitFor(() => expect(orchestration.waitForWorkflow).toHaveBeenCalledTimes(1));
      leave();
      await vi.waitFor(() => expect(orchestration.cancelWorkflow).toHaveBeenCalledWith('wf_leave'));
    });

    test('leaving while the price is re-checked submits nothing', async () => {
      const orchestration = holdingOrchestration();
      let answer: (buzz: number) => void = () => undefined;
      const requote = vi.fn(() => new Promise<number>((resolve) => (answer = resolve)));
      const card = await withOrchestration(orchestration, requote).open();
      pressButton(card)!.click();
      await vi.waitFor(() => expect(requote).toHaveBeenCalledTimes(1));
      leave();
      // The re-quote answers after the user left, at the offered price: still nothing is made.
      answer(PRICE);
      // Settled when either happens: a submit, or the press ending without one.
      await vi.waitFor(() =>
        expect(
          orchestration.submitWorkflow.mock.calls.length > 0 ||
            !card.textContent!.includes(COVER_MAKING_TEXT)
        ).toBe(true)
      );
      expect(orchestration.submitWorkflow).not.toHaveBeenCalled();
    });

    test('asks before the page unloads while a cover is being made, and not after', async () => {
      const orchestration = holdingOrchestration();
      const card = await withOrchestration(orchestration).open();
      const unload = () => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      };
      // Earlier cases leave presses running; leaving ends them, and with them their prompts.
      leave();
      await vi.waitFor(() => expect(unload()).toBe(false));
      pressButton(card)!.click();
      await vi.waitFor(() => expect(orchestration.waitForWorkflow).toHaveBeenCalledTimes(1));
      expect(unload()).toBe(true);
      leave();
      await vi.waitFor(() => expect(orchestration.cancelWorkflow).toHaveBeenCalled());
      await vi.waitFor(() => expect(unload()).toBe(false));
    });
  });
});
