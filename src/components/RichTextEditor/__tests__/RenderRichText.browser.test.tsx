import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import type * as RenderHtmlModule from '~/components/RenderHtml/RenderHtml';

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
});
