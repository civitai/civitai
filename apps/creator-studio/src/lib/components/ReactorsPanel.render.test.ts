// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReactorsPanel from './ReactorsPanel.svelte';
import { emptyCounts, type ReactorPage } from '$lib/analytics/reactors';

// Vitest resolves `svelte` to its server build; a mounted component needs the client one, which the
// package serves only under the `browser` condition.
vi.mock('svelte', async () => {
  const { createRequire } = await import('node:module');
  const { dirname, join } = await import('node:path');
  const pkg = createRequire(import.meta.url).resolve('svelte/package.json');
  return import(/* @vite-ignore */ join(dirname(pkg), 'src/index-client.js'));
});
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/navigation', () => ({ goto: async () => undefined }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://cs.test/analytics') } }));
vi.mock('$lib/media/edge-url', () => ({ getEdgeUrl: (u: string) => u }));
vi.mock('$lib/model-url', () => ({ civitaiUrl: (p: string) => `https://civitai.test/${p}` }));

const answer = (page: ReactorPage) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(page), { status: 200 }))
  );

const reactor = {
  userId: 7,
  username: 'fan',
  image: null,
  reactedAt: '2026-10-01T12:00:00.000Z',
  deleted: false,
  banned: false,
  follows: false,
};

let app: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function loaded(props: Record<string, unknown>) {
  app = mount(ReactorsPanel, { target: document.body, props: props as never });
  for (let i = 0; i < 10 && !document.body.querySelector('li'); i++) {
    await new Promise((r) => setTimeout(r, 0));
    await tick();
    flushSync();
  }
  const panel = document.body.querySelector('section');
  if (!panel?.querySelector('li')) throw new Error(`panel never loaded: ${panel?.textContent}`);
  return {
    text: (panel.textContent ?? '').replace(/\s+/g, ' '),
    tabs: [...panel.querySelectorAll('[role="radio"], [data-toggle-group-item]')].map((t) =>
      (t.textContent ?? '').replace(/\s+/g, ' ').trim()
    ),
  };
}

describe('ReactorsPanel', () => {
  it('keeps the image and article panel as it was: every reaction tab, "Reacted", "reactions"', async () => {
    answer({
      reaction: 'Heart',
      counts: { ...emptyCounts(), Like: 2, Heart: 1 },
      reactors: [reactor],
      next: null,
      prev: null,
    });
    const { text, tabs } = await loaded({ endpoint: '/x/reactors', noun: 'image' });
    expect(text).toContain('Who reacted');
    expect(tabs).toHaveLength(4);
    expect(tabs.map((t) => t.split(' ')[1])).toEqual(['Like', 'Heart', 'Laugh', 'Cry']);
    expect(text).toContain('Reacted Oct 1, 2026');
    expect(text).toContain('reactions · 1 shown');
  });

  it('shows a single-type list without tabs, in its own words', async () => {
    answer({
      reaction: 'Like',
      counts: { ...emptyCounts(), Like: 5 },
      reactors: [reactor],
      next: null,
      prev: null,
    });
    const { text, tabs } = await loaded({
      endpoint: '/x/likers',
      noun: 'model',
      types: ['Like'],
      title: 'Who liked',
      verb: 'Liked',
      unit: 'likes',
    });
    expect(tabs).toEqual([]);
    expect(text).toContain('Who liked');
    expect(text).not.toContain('Who reacted');
    expect(text).toContain('Liked Oct 1, 2026');
    expect(text).toContain('5 👍 likes · 1 shown');
  });
});
