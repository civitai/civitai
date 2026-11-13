import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import ReactorsPanel from './ReactorsPanel.svelte';

vi.mock('$app/environment', () => ({ browser: false }));
vi.mock('$app/navigation', () => ({ goto: async () => undefined }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://cs.test/analytics') } }));
vi.mock('$lib/media/edge-url', () => ({ getEdgeUrl: (u: string) => u }));
vi.mock('$lib/model-url', () => ({ civitaiUrl: (p: string) => `https://civitai.test/${p}` }));

// The server half renders the header and the loading state; the list itself loads in the browser.
const tabPlaceholders = (body: string) => body.split('h-8 w-20').length - 1;

describe('ReactorsPanel', () => {
  it('keeps the image and article panel as it was: "Who reacted", one tab per reaction type', () => {
    const { body } = render(ReactorsPanel, { props: { endpoint: '/x/reactors', noun: 'image' } });
    expect(body).toContain('aria-label="Who reacted"');
    expect(body).toContain('Loading who reacted…');
    expect(tabPlaceholders(body)).toBe(4);
  });

  it('drops the type tabs for a single-type list and uses its own title', () => {
    const { body } = render(ReactorsPanel, {
      props: { endpoint: '/x/likers', noun: 'model', types: ['Like'], title: 'Who liked' },
    });
    expect(body).toContain('aria-label="Who liked"');
    expect(body).not.toContain('Who reacted');
    expect(tabPlaceholders(body)).toBe(0);
  });
});
