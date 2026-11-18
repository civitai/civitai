import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ReactNode } from 'react';
import type * as TrpcUtils from '~/utils/trpc';
import type * as TipBuzzButton from '~/components/Buzz/InteractiveTipBuzzButton';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';

// The "+N Team" pop rises off the button that was pressed, measured where it renders: centred on
// that button, and moved only as far as keeps it on a phone's screen.

type Answer = { result: 'created'; eventPoints: { event: string; team: string; points: number }[] };

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcUtils>()),
  trpc: makeTrpcProxy({
    'reaction.toggleWithPoints': {
      useMutation: (opts: { onSuccess: (data: Answer, vars: unknown) => void }) => ({
        mutate: (vars: unknown) =>
          opts.onSuccess(
            { result: 'created', eventPoints: [{ event: 'e', team: 'Yellow', points: 15 }] },
            vars
          ),
        isPending: false,
      }),
    },
  }),
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({}),
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, muted: false }),
}));

vi.mock('~/components/Buzz/InteractiveTipBuzzButton', async (importOriginal) => ({
  ...(await importOriginal<typeof TipBuzzButton>()),
  InteractiveTipBuzzButton: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import { Reactions } from '~/components/Reaction/Reactions';

const metrics = { likeCount: 12, heartCount: 4, laughCount: 1, cryCount: 0 };

const pop = () => document.querySelector<HTMLElement>('[data-testid="event-point-pop"]');
const centreX = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.left + r.width / 2;
};

async function pressAndPop(entityId: number, name: string, { flushLeft = false } = {}) {
  renderWithProviders(
    <div data-testid="row" style={{ padding: '0 16px' }}>
      <Reactions entityType="image" entityId={entityId} reactions={[]} metrics={metrics} />
    </div>
  );
  const button = page.getByRole('button', { name });
  await expect.element(button).toBeInTheDocument();
  if (flushLeft) {
    // Slide the row so this button starts at the screen's left edge.
    const row = document.querySelector<HTMLElement>('[data-testid="row"]')!;
    row.style.marginLeft = `${-button.element().getBoundingClientRect().left}px`;
  }
  await button.click();
  await vi.waitFor(() => expect(pop()).not.toBeNull());
  return { button: button.element(), pop: pop()! };
}

afterEach(() => pop()?.remove());

describe('the point pop', () => {
  test('is centred on the pressed button, not on the row', async () => {
    await page.viewport(1280, 720);
    // The middle button: a pop anchored to the row's start, or to the first button, misses it.
    const { button, pop } = await pressAndPop(9101, 'Heart reaction');
    expect(pop.textContent).toBe('+15 Yellow points');
    expect(Math.abs(centreX(pop) - centreX(button))).toBeLessThanOrEqual(2);
  });

  test('by the left edge of a phone, moves only as far as keeps it on screen', async () => {
    await page.viewport(390, 844);
    const { button, pop } = await pressAndPop(9102, 'Like reaction', { flushLeft: true });
    const rect = pop.getBoundingClientRect();
    // Centred on this button it would start left of the 8px margin, so it stops at the margin.
    expect(centreX(button) - pop.offsetWidth / 2).toBeLessThan(8);
    // The layout box, not the rect: the rise scales it, which narrows the rect around the same centre.
    expect(Math.abs(pop.offsetLeft - pop.offsetWidth / 2 - 8)).toBeLessThanOrEqual(1);
    // Still over the button it came from.
    const b = button.getBoundingClientRect();
    expect(rect.left).toBeLessThan(b.right);
    expect(rect.right).toBeGreaterThan(b.left);
  });
});
