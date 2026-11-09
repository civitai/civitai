import { describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../test/component-setup';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { Sticker } from '~/components/Sticker/Sticker';
import { STICKER_SIZE } from '~/shared/utils/sticker-token';

vi.mock('~/components/UserAvatar/MentionHoverCard', () => ({ MentionHoverCard: () => null }));
vi.mock('~/providers/BrowserSettingsProvider', () => ({
  useBrowsingSettings: (select: (s: { blurNsfw: boolean }) => unknown) =>
    select({ blurNsfw: false }),
}));

// A 1:1 square, so the box is the same whether or not the art has loaded.
const ART =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>';
const resolved = { id: 7, name: 'Wave', slug: 'wave', url: ART, animated: false };

// The CDN rewrite would mangle the data URL; the layout under test is the img's own.
vi.mock('~/client-utils/cf-images-utils', async (orig) => ({
  ...(await orig<object>()),
  useEdgeUrl: (src: string) => ({ url: src, srcSet: undefined }),
}));
vi.mock('~/client-utils/edge-url', async (orig) => ({
  ...(await orig<object>()),
  getEdgeUrl: (src: string) => src,
}));

vi.mock('~/components/Sticker/sticker.util', async (orig) => ({
  ...(await orig<object>()),
  useStickerCosmetics: () => ({ sticker: new Map([[7, resolved]]), isLoading: false }),
}));

const TEXT_STYLE = { width: 300, fontSize: 14, lineHeight: 1.55 } as const;
const TEXT = 'Lovely image!!';

const textCentre = (p: Element) => {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  range.selectNodeContents(walker.nextNode()!);
  const r = range.getBoundingClientRect();
  return r.top + r.height / 2;
};
const centreOf = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.top + r.height / 2;
};

async function plainHeight() {
  await renderWithProviders(
    <div style={TEXT_STYLE}>
      <p data-testid="plain" style={{ margin: 0 }}>
        {TEXT}
      </p>
    </div>
  );
  return document.querySelector<HTMLElement>('[data-testid="plain"]')!.getBoundingClientRect()
    .height;
}

describe('inline sticker alignment', () => {
  test('a RenderHtml comment keeps its line height and centres the sticker on the text', async () => {
    const plain = await plainHeight();
    document.body.replaceChildren();
    await renderWithProviders(
      <div style={TEXT_STYLE}>
        <RenderHtml
          allowStickers
          html={`<p style="margin:0">${TEXT} <span data-type="sticker" data-id="7"></span></p>`}
        />
      </div>
    );
    const img = await vi.waitFor(() => {
      const el = document.querySelector('[data-type="sticker"] img');
      if (!el) throw new Error('sticker not hydrated yet');
      return el;
    });
    const p = img.closest('p')!;
    expect(img.getBoundingClientRect().height).toBe(STICKER_SIZE.inline);
    expect(p.getBoundingClientRect().height).toBe(plain);
    expect(Math.abs(centreOf(img) - textCentre(p))).toBeLessThanOrEqual(2);
  });

  test('the Sticker component keeps its line height and centres on the text', async () => {
    const plain = await plainHeight();
    document.body.replaceChildren();
    await renderWithProviders(
      <div style={TEXT_STYLE}>
        <p data-testid="p" style={{ margin: 0 }}>
          {TEXT} <Sticker cosmeticId={7} />
        </p>
      </div>
    );
    const p = document.querySelector<HTMLElement>('[data-testid="p"]')!;
    const img = p.querySelector('img')!;
    expect(img.getBoundingClientRect().height).toBe(STICKER_SIZE.inline);
    expect(p.getBoundingClientRect().height).toBe(plain);
    expect(Math.abs(centreOf(img) - textCentre(p))).toBeLessThanOrEqual(2);
  });

  test('a jumbo sticker keeps its own full-size box', async () => {
    await renderWithProviders(
      <div style={TEXT_STYLE}>
        <p data-testid="p" style={{ margin: 0 }}>
          <Sticker cosmeticId={7} size={STICKER_SIZE.jumbo} />
        </p>
      </div>
    );
    const p = document.querySelector<HTMLElement>('[data-testid="p"]')!;
    expect(p.getBoundingClientRect().height).toBeGreaterThanOrEqual(STICKER_SIZE.jumbo);
  });

  test('a RenderHtml line of only a sticker renders jumbo and keeps its full box', async () => {
    await renderWithProviders(
      <div style={TEXT_STYLE}>
        <RenderHtml
          allowStickers
          html={`<p style="margin:0"><span data-type="sticker" data-id="7"></span></p>`}
        />
      </div>
    );
    const img = await vi.waitFor(() => {
      const el = document.querySelector('[data-type="sticker"] img');
      if (!el) throw new Error('sticker not hydrated yet');
      return el;
    });
    expect(img.closest('p')!.getBoundingClientRect().height).toBeGreaterThanOrEqual(
      STICKER_SIZE.jumbo
    );
  });
});
