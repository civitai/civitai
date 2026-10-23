// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingStorylineDraft } from '~/components/Storyline/editor/useStorylineDraftPublish';
import { useStorylineDraftPublish } from '~/components/Storyline/editor/useStorylineDraftPublish';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';

const mocks = vi.hoisted(() => ({
  viewerId: 5 as number | undefined,
  terms: {
    data: { open: true, price: 50, closedReason: null } as null | {
      open: boolean;
      price: number;
      closedReason: 'closed' | 'collaboratorsOnly' | null;
    },
    isLoading: false,
    unavailable: false,
  },
  termsArgs: vi.fn(),
  invalidate: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => (mocks.viewerId ? { id: mocks.viewerId } : null),
}));
vi.mock('~/components/Storyline/storyline.data', () => ({
  useStorylineContinueTerms: (parentPostId: number, options: { enabled: boolean }) => {
    mocks.termsArgs(parentPostId, options);
    return mocks.terms;
  },
}));
vi.mock('~/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ placement: { getStorylineContinuePrice: { invalidate: mocks.invalidate } } }),
  },
}));
vi.mock('~/utils/notifications', () => ({ showWarningNotification: mocks.warn }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = 9;
const WRITER = 5;

function pending(overrides: Partial<NonNullable<PendingStorylineDraft>> = {}) {
  return {
    postId: 40,
    storyline: { userId: OWNER },
    parentChapter: { id: 4, depth: 3, postId: 15 },
    ...overrides,
  } as NonNullable<PendingStorylineDraft>;
}

type Result = ReturnType<typeof useStorylineDraftPublish>;
function mount(draft: PendingStorylineDraft | null | undefined, authorId = WRITER) {
  const out: { current: Result | null } = { current: null };
  function Probe() {
    out.current = useStorylineDraftPublish({ post: { user: { id: authorId } }, pending: draft });
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => createRoot(container).render(createElement(Probe)));
  return out as { current: Result };
}

beforeEach(() => {
  document.body.innerHTML = '';
  mocks.viewerId = WRITER;
  mocks.terms = { data: { open: true, price: 50, closedReason: null }, isLoading: false, unavailable: false };
  mocks.termsArgs.mockClear();
  mocks.invalidate.mockReset().mockResolvedValue(undefined);
  mocks.warn.mockClear();
});

describe('a contributor’s continuation draft', () => {
  it('sends the price its button shows', () => {
    const { current } = mount(pending());
    expect([current.label, current.expectedPrice]).toEqual(['Publish and submit · 50 Buzz', 50]);
  });

  // Free is a price too: the server refuses a publish that does not name it.
  it('sends 0 for a free storyline, not nothing', () => {
    mocks.terms.data = { open: true, price: 0, closedReason: null };
    const { current } = mount(pending());
    expect([current.label, current.expectedPrice]).toEqual(['Publish and submit · Free', 0]);
  });

  it('follows the price when it changes, label and amount together', () => {
    mocks.terms.data = { open: true, price: 1200, closedReason: null };
    const { current } = mount(pending());
    expect([current.label, current.expectedPrice]).toEqual([
      'Publish and submit · 1,200 Buzz',
      1200,
    ]);
  });

  it('reads the price of the chapter it continues', () => {
    mount(pending());
    expect(mocks.termsArgs).toHaveBeenCalledWith(15, { enabled: true });
  });

  it('sends no price and cannot publish while the price is being read', () => {
    mocks.terms.isLoading = true;
    const { current } = mount(pending());
    expect([current.expectedPrice, current.blocked, current.caption]).toEqual([
      undefined,
      true,
      'Checking what this costs…',
    ]);
  });

  it('cannot publish when the price cannot be read, and says so', () => {
    mocks.terms.data = null;
    const { current } = mount(pending());
    expect([current.expectedPrice, current.blocked]).toEqual([undefined, true]);
    expect(current.caption).toContain("Couldn't read what this costs");
  });

  it('publishes on its own, with no price, once the terms are closed', () => {
    mocks.terms.data = { open: false, price: 0, closedReason: 'collaboratorsOnly' };
    const { current } = mount(pending());
    expect([current.label, current.expectedPrice, current.blocked]).toEqual([
      undefined,
      undefined,
      false,
    ]);
    expect(current.caption).toBe(
      'Only collaborators can continue this storyline, so publishing posts it on its own.'
    );
  });

  it('tells the writer what happens to the Buzz', () => {
    expect(mount(pending()).current.caption).toBe(
      'Goes to the creator for review. If they do not answer in 7 days it expires and your 50 Buzz is refunded.'
    );
  });
});

describe('the price is sent only for a contributor’s draft', () => {
  it('not for the storyline owner continuing their own story, who gets the chapter number', () => {
    mocks.viewerId = OWNER;
    const { current } = mount(pending(), OWNER);
    expect([current.label, current.expectedPrice, current.blocked]).toEqual([
      'Publish chapter 5',
      undefined,
      false,
    ]);
    // Their own storyline has no price to read.
    expect(mocks.termsArgs).toHaveBeenCalledWith(15, { enabled: false });
  });

  it('not for chapter 1, which has no chapter it continues', () => {
    const { current } = mount(pending({ parentChapter: null }));
    expect([current.plan, current.label, current.expectedPrice]).toEqual([null, undefined, undefined]);
  });

  it('not for a post that is not linked to a storyline', () => {
    expect(mount(null).current.expectedPrice).toBeUndefined();
    expect(mount(undefined).current.expectedPrice).toBeUndefined();
  });

  // The server does not submit a contributor's draft published by someone else; a price sent
  // would only count against the author's quota.
  it('not when someone other than the author is publishing it', () => {
    mocks.viewerId = 77;
    const { current } = mount(pending());
    expect([current.plan, current.expectedPrice]).toEqual([null, undefined]);
  });
});

describe('a refused price', () => {
  it('re-reads the price of that chapter and tells the writer the new one', async () => {
    const { current } = mount(pending());
    let handled: boolean | undefined;
    await act(async () => {
      handled = await current.handleError(
        new Error(`${STORYLINE_REFUSALS.priceChanged}: now 60 Buzz`)
      );
    });
    expect(handled).toBe(true);
    expect(mocks.invalidate.mock.calls).toEqual([[{ parentPostId: 15 }]]);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'The price changed',
        message: 'It is now 60 Buzz. Publish again to accept it.',
      })
    );
  });

  it('holds the button until the new price is in', async () => {
    const result = mount(pending());
    let release = () => undefined as void;
    mocks.invalidate.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
    let done: Promise<boolean> | undefined;
    await act(async () => {
      done = result.current.handleError(
        new Error(`${STORYLINE_REFUSALS.priceChanged}: now 60 Buzz`)
      );
    });
    expect([result.current.blocked, result.current.expectedPrice]).toEqual([true, undefined]);
    await act(async () => {
      release();
      await done;
    });
    expect(result.current.blocked).toBe(false);
  });

  it('leaves any other refusal to the editor', async () => {
    const { current } = mount(pending());
    let handled: boolean | undefined;
    await act(async () => {
      handled = await current.handleError(new Error(STORYLINE_REFUSALS.notOpen));
    });
    expect(handled).toBe(false);
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
