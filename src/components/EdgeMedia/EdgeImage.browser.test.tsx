import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// `useEdgeUrl` reads the CivitaiSession context (throws without a provider) and
// builds a CF-resized URL. This test is about the LCP `priority` attributes, not
// URL construction, so mock the hook to a fixed absolute URL. This also keeps the
// leaf test network-free and provider-light (matches the scaffold's philosophy).
const TEST_URL = 'https://example.com/lcp-test.jpg';
vi.mock('~/client-utils/cf-images-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/client-utils/cf-images-utils')>();
  return {
    ...actual,
    useEdgeUrl: () => ({ url: TEST_URL, type: 'image' as const }),
  };
});

// The LCP fix renders the canonical lowercase HTML attributes. react-dom 18.3.1
// has no `fetchPriority` in its known-attribute map, so we emit lowercase
// `fetchpriority`, which the browser reads case-insensitively.
//
// NB: EdgeImage's props are `React.HTMLAttributes` (not `ImgHTMLAttributes`), so
// `alt` is not one of its typed props — real callers pass `alt` via EdgeMedia's
// img-prop spread. The EdgeImage renders below therefore omit `alt`; an <img>
// with no alt attribute still has the implicit `img` role.
async function getImg() {
  const el = page.getByRole('img');
  await expect.element(el).toBeInTheDocument();
  return el.element() as HTMLImageElement;
}

describe('EdgeImage — LCP priority', () => {
  test('priority renders fetchpriority="high" + loading="eager"', async () => {
    renderWithProviders(<EdgeImage src={TEST_URL} options={{}} priority />);

    const img = await getImg();
    expect(img.getAttribute('fetchpriority')).toBe('high');
    expect(img.getAttribute('loading')).toBe('eager');
  });

  test('no priority prop → no priority attributes (byte-identical / flag-off)', async () => {
    renderWithProviders(<EdgeImage src={TEST_URL} options={{}} />);

    const img = await getImg();
    expect(img.hasAttribute('fetchpriority')).toBe(false);
    expect(img.hasAttribute('loading')).toBe(false);
  });

  test('priority={false} → no priority attributes', async () => {
    renderWithProviders(<EdgeImage src={TEST_URL} options={{}} priority={false} />);

    const img = await getImg();
    expect(img.hasAttribute('fetchpriority')).toBe(false);
    expect(img.hasAttribute('loading')).toBe(false);
  });
});

describe('EdgeMedia — LCP priority threading', () => {
  test('image branch forwards priority to the underlying <img>', async () => {
    renderWithProviders(<EdgeMedia type="image" src={TEST_URL} priority alt="test" />);

    const img = await getImg();
    expect(img.getAttribute('fetchpriority')).toBe('high');
    expect(img.getAttribute('loading')).toBe('eager');
  });

  test('image branch without priority emits no priority attributes', async () => {
    renderWithProviders(<EdgeMedia type="image" src={TEST_URL} alt="test" />);

    const img = await getImg();
    expect(img.hasAttribute('fetchpriority')).toBe(false);
    expect(img.hasAttribute('loading')).toBe(false);
  });
});
