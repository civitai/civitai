import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import type * as SessionProviderModule from '~/providers/SessionProvider';
import type * as TrpcMod from '~/utils/trpc';

/**
 * A fast-path trigger attaches its arming listeners (capturing, passive, on the trigger node) and
 * removes them when it arms, in the arming event itself: an armed trigger keeps none of them.
 *
 * Observed through a ledger of every `addEventListener` / `removeEventListener` call on the
 * trigger node, keyed by (type, listener, capture). Before arming, the nine listeners must be live
 * (the positive control: a ledger that never saw them would make "none left" vacuous). The arming
 * event is dispatched synchronously and the ledger is read before anything else runs, so the
 * removal has to happen in the arming event's own dispatch. Mantine then mounting (a portal node)
 * proves the event did arm.
 */

vi.mock('~/providers/SessionProvider', async (orig) => ({
  ...(await orig<typeof SessionProviderModule>()),
  useSession: () => ({ data: null, status: 'unauthenticated', update: async () => null }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'user.getFeatureFlags': {
        useQuery: () => ({ data: {}, isSuccess: true, isError: false }),
      },
    }),
  };
});

const { Tooltip, Popover, Menu, HoverCard, OverlayFastPathContext } = await import(
  '~/components/MantineOverlays'
);
const { theme: appTheme } = await import('~/providers/ThemeProvider');

/** Pinned literally, not imported from the implementation. */
const ARMING_TYPES = [
  'click',
  'focus',
  'keydown',
  'mousedown',
  'mouseover',
  'pointerdown',
  'pointermove',
  'pointerover',
  'touchstart',
];

type Entry = {
  op: 'add' | 'remove';
  target: EventTarget;
  type: string;
  listener: unknown;
  capture: boolean;
  passive: boolean;
};

let ledger: Entry[] = [];
let restore: (() => void) | null = null;

const flag = (options: unknown, key: 'capture' | 'passive') =>
  typeof options === 'boolean'
    ? key === 'capture' && options
    : !!(options as Record<string, unknown> | undefined)?.[key];

beforeEach(() => {
  ledger = [];
  const proto = EventTarget.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  proto.addEventListener = function (this: EventTarget, type, listener, options) {
    ledger.push({
      op: 'add',
      target: this,
      type,
      listener,
      capture: flag(options, 'capture'),
      passive: flag(options, 'passive'),
    });
    return add.call(this, type, listener, options);
  };
  proto.removeEventListener = function (this: EventTarget, type, listener, options) {
    ledger.push({
      op: 'remove',
      target: this,
      type,
      listener,
      capture: flag(options, 'capture'),
      passive: false,
    });
    return remove.call(this, type, listener, options);
  };
  restore = () => {
    proto.addEventListener = add;
    proto.removeEventListener = remove;
  };
});

afterEach(() => {
  restore?.();
  restore = null;
});

/** Capturing listeners of the arming types still live on `node`, as sorted `type` strings. */
function liveArmingListeners(node: EventTarget): string[] {
  const live = new Map<string, Entry>();
  const listenerIds = new Map<unknown, number>();
  const id = (l: unknown) => {
    if (!listenerIds.has(l)) listenerIds.set(l, listenerIds.size);
    return listenerIds.get(l);
  };
  for (const e of ledger) {
    if (e.target !== node || !e.capture || !ARMING_TYPES.includes(e.type)) continue;
    const key = `${e.type}|${id(e.listener)}`;
    if (e.op === 'add') {
      if (!live.has(key)) live.set(key, e);
    } else live.delete(key);
  }
  return [...live.values()].map((e) => e.type).sort();
}

const portalCount = () => document.querySelectorAll('[data-portal="true"]').length;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <MantineProvider theme={appTheme}>
      <OverlayFastPathContext.Provider value>
        <div style={{ padding: '160px 0 0 240px' }}>{children}</div>
      </OverlayFastPathContext.Provider>
    </MantineProvider>
  );
}

describe.each([
  [
    'Tooltip',
    <Tooltip key="t" label="Tip" withinPortal>
      <button type="button">Trigger</button>
    </Tooltip>,
  ],
  [
    'Popover',
    <Popover key="p" withinPortal>
      <Popover.Target>
        <button type="button">Trigger</button>
      </Popover.Target>
      <Popover.Dropdown>Body</Popover.Dropdown>
    </Popover>,
  ],
  [
    'Menu',
    <Menu key="m" withinPortal>
      <Menu.Target>
        <button type="button">Trigger</button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item>Item</Menu.Item>
      </Menu.Dropdown>
    </Menu>,
  ],
  [
    'HoverCard',
    <HoverCard key="h" withinPortal>
      <HoverCard.Target>
        <button type="button">Trigger</button>
      </HoverCard.Target>
      <HoverCard.Dropdown>Card</HoverCard.Dropdown>
    </HoverCard>,
  ],
] as const)('%s on the fast path', (_name, ui) => {
  test('the arming event removes all nine arming listeners from the trigger', async () => {
    const before = portalCount();
    await render(<Shell>{ui}</Shell>);
    const node = page.getByRole('button', { name: 'Trigger' }).element();

    // Positive control: unarmed, Mantine not mounted, and the nine listeners are live.
    expect(portalCount() - before, 'portal nodes before arming').toBe(0);
    expect(liveArmingListeners(node), 'arming listeners before arming').toEqual(ARMING_TYPES);
    for (const e of ledger.filter((e) => e.target === node && e.op === 'add'))
      if (ARMING_TYPES.includes(e.type)) expect(e.passive, `${e.type} is passive`).toBe(true);

    // Arm, and read the ledger before any microtask or task runs.
    node.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true }));
    expect(liveArmingListeners(node), 'arming listeners right after the arming event').toEqual([]);

    // It did arm: Mantine mounted. And nothing re-attached once it settled.
    await expect.poll(() => portalCount() - before).toBeGreaterThan(0);
    expect(liveArmingListeners(node), 'arming listeners once settled').toEqual([]);
    const addsAfterArm = ledger.length;
    node.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true }));
    expect(
      ledger
        .slice(addsAfterArm)
        .filter((e) => e.target === node && e.op === 'add' && ARMING_TYPES.includes(e.type)),
      'arming listeners added by a second event'
    ).toEqual([]);
  });
});
