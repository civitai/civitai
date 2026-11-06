import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { Root } from 'react-dom/client';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'vitest';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { IsClientProvider, useIsClient } from '~/providers/IsClientProvider';
import dayjs from '~/shared/utils/dayjs';

/**
 * `useIsClient` with no `IsClientProvider` above it (any component test harness, and any tree
 * not under `_app`) must not throw, and must stay hydration-safe: `false` in the server HTML and
 * on the hydration render, `true` after.
 *
 * Mismatch detector: `hydrateRoot`'s `onRecoverableError`. The control test proves it reports a
 * real mismatch. Each test waits for the value to flip to its client state, which only a completed
 * hydration produces, so "no mismatch" can't come from a hydration that never ran.
 */

const roots: Root[] = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => root.unmount());
  containers.splice(0).forEach((container) => container.remove());
});

function hydrate(server: ReactElement, client: ReactElement = server) {
  const container = document.createElement('div');
  container.innerHTML = renderToString(server);
  document.body.appendChild(container);
  containers.push(container);
  const recoverable: string[] = [];
  roots.push(
    hydrateRoot(container, client, {
      onRecoverableError: (err) =>
        recoverable.push(err instanceof Error ? err.message : String(err)),
    })
  );
  return { container, recoverable };
}

function Probe() {
  return <span data-testid="probe">{useIsClient() ? 'client' : 'server'}</span>;
}

describe('useIsClient without an IsClientProvider', () => {
  test('renders on the server, as the placeholder', () => {
    expect(renderToString(<Probe />)).toContain('server');
  });

  test('hydrates without a mismatch, then reads true', async () => {
    const { container, recoverable } = hydrate(<Probe />);
    expect(container.textContent).toBe('server');
    await expect.poll(() => container.textContent).toBe('client');
    expect(recoverable).toEqual([]);
  });

  test('DaysFromNow: nothing in the server HTML, the <time> after hydration', async () => {
    const date = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const { container, recoverable } = hydrate(<DaysFromNow date={date} />);
    expect(container.innerHTML).toBe('');
    await expect.poll(() => container.querySelector('time')).not.toBeNull();
    const time = container.querySelector('time')!;
    expect(time.textContent).toBe('3 days ago');
    expect(time.getAttribute('title')).toBe(dayjs(date).format());
    expect(time.getAttribute('datetime')).toBe(dayjs(date).format());
    expect(recoverable).toEqual([]);
  });
});

test('with an IsClientProvider: the same placeholder-then-value, no mismatch', async () => {
  const tree = (
    <IsClientProvider>
      <Probe />
    </IsClientProvider>
  );
  const { container, recoverable } = hydrate(tree);
  expect(container.textContent).toBe('server');
  await expect.poll(() => container.textContent).toBe('client');
  expect(recoverable).toEqual([]);
});

test('instrument check: a real server/client mismatch is reported', async () => {
  const { container, recoverable } = hydrate(<span>server</span>, <span>client</span>);
  await expect.poll(() => container.textContent).toBe('client');
  expect(recoverable.length).toBeGreaterThan(0);
});
