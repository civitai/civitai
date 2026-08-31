import { generateJSON } from '@tiptap/html';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import type * as RenderHtmlModule from '~/components/RenderHtml/RenderHtml';
import { tiptapExtensions } from '~/shared/tiptap/extensions';

// The fallback path is what's under test, not RenderHtml's own rendering — the real
// component resolves sticker artwork over tRPC and reads browsing settings, neither of
// which this scaffold provides.
vi.mock('~/components/RenderHtml/RenderHtml', async (importOriginal) => ({
  ...(await importOriginal<typeof RenderHtmlModule>()),
  RenderHtml: ({ html }: { html: string }) => <div data-testid="fallback">{html}</div>,
}));

const { RenderRichText } = await import('~/components/RichTextEditor/RenderRichText');

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

// Node types outside the component's `extensions` throw while the doc is built, before
// `nodeMapping` is consulted — so no mapping entry can absorb them.
const unknownNode = { type: 'doc', content: [{ type: 'sticker', attrs: { id: '1' } }] };

describe('RenderRichText', () => {
  test('renders a valid document', async () => {
    renderWithProviders(<RenderRichText content={paragraph('a real article')} />);

    await expect.element(page.getByText('a real article')).toBeInTheDocument();
  });

  test('falls back to the sanitized HTML when the document cannot be rendered', async () => {
    renderWithProviders(
      <RenderRichText content={unknownNode} fallbackHtml="<p>the original body</p>" />
    );

    await expect.element(page.getByTestId('fallback')).toHaveTextContent('the original body');
  });

  test('renders nothing rather than throwing when there is no fallback', async () => {
    renderWithProviders(
      <div data-testid="host">
        <RenderRichText content={unknownNode} />
      </div>
    );

    await expect.element(page.getByTestId('host')).toBeEmptyDOMElement();
  });

  test('renders a blurb containing formatting as real markup, not escaped text', async () => {
    const doc = generateJSON(
      '<div data-type="blurb" data-id="7"><strong>bold</strong> text</div>',
      tiptapExtensions
    );

    renderWithProviders(
      <div data-testid="host">
        <RenderRichText content={doc} />
      </div>
    );

    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="host"] strong')).not.toBeNull()
    );
    expect(document.querySelector('[data-testid="host"] strong')?.textContent).toBe('bold');
    expect(document.querySelector('[data-testid="host"]')?.innerHTML).not.toContain(
      '&lt;strong&gt;'
    );
  });

  test('a second parse/render cycle does not escalate the escaping', async () => {
    const html = '<div data-type="blurb" data-id="7"><strong>bold</strong> text</div>';
    const firstDoc = generateJSON(html, tiptapExtensions);

    renderWithProviders(
      <div data-testid="first">
        <RenderRichText content={firstDoc} />
      </div>
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="first"] div[data-type="blurb"]')).not.toBeNull()
    );

    // Re-parse exactly what the first (fixed) render produced — simulating a later
    // request re-generating the doc from the same stored HTML — and render again.
    const rerendered = document.querySelector(
      '[data-testid="first"] div[data-type="blurb"]'
    )!.outerHTML;
    const secondDoc = generateJSON(rerendered, tiptapExtensions);

    renderWithProviders(
      <div data-testid="second">
        <RenderRichText content={secondDoc} />
      </div>
    );

    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="second"] strong')).not.toBeNull()
    );
    expect(document.querySelector('[data-testid="second"] strong')?.textContent).toBe('bold');
    expect(document.querySelector('[data-testid="second"]')?.innerHTML).not.toContain('&lt;');
  });

  test('a blurb containing an iframe renders without a live iframe', async () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'blurb',
              attrs: {
                id: 7,
                text: '<strong>bold</strong><iframe src="https://www.youtube.com/embed/x"></iframe>',
              },
            },
          ],
        },
      ],
    };

    renderWithProviders(
      <div data-testid="host">
        <RenderRichText content={doc} />
      </div>
    );

    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="host"] strong')).not.toBeNull()
    );
    expect(document.querySelector('[data-testid="host"] strong')?.textContent).toBe('bold');
    expect(document.querySelector('[data-testid="host"] iframe')).toBeNull();
  });

  test('a blurb containing a styled span renders without the dangerous style reaching the DOM', async () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'blurb',
          attrs: {
            id: 7,
            text: '<span style="background:url(javascript:alert(1))">styled</span> text',
          },
        },
      ],
    };

    renderWithProviders(
      <div data-testid="host">
        <RenderRichText content={doc} />
      </div>
    );

    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="host"]')?.textContent).toContain('styled')
    );
    // `span` is allowed inside a blurb now, for text colour. `color` is the only property the
    // allowlist names, so everything else in `style` goes — the tag surviving is not the risk.
    const blurb = document.querySelector('[data-testid="host"] div[data-type="blurb"]');
    expect(blurb?.innerHTML).not.toContain('background');
    expect(blurb?.innerHTML).not.toContain('javascript:');
  });

  test('a blurb keeps a text colour, which is the one style it may carry', async () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'blurb',
          attrs: { id: 7, text: '<span style="color: #fa5252">red</span>' },
        },
      ],
    };

    renderWithProviders(
      <div data-testid="host">
        <RenderRichText content={doc} />
      </div>
    );

    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="host"]')?.textContent).toContain('red')
    );
    const colored = document.querySelector('[data-testid="host"] div[data-type="blurb"] span');
    expect(colored?.getAttribute('style')).toContain('color');
  });

  test("a blurb's emphasis and link formatting survive the render-time sanitize", async () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'blurb',
          attrs: {
            id: 7,
            text: '<em>emphasis</em> and <a href="https://example.com">a link</a>',
          },
        },
      ],
    };

    renderWithProviders(
      <div data-testid="host">
        <RenderRichText content={doc} />
      </div>
    );

    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="host"] em')).not.toBeNull()
    );
    expect(document.querySelector('[data-testid="host"] em')?.textContent).toBe('emphasis');
    const link = document.querySelector<HTMLAnchorElement>('[data-testid="host"] a');
    expect(link?.textContent).toBe('a link');
    expect(link?.getAttribute('href')).toBe('https://example.com');
  });
});
