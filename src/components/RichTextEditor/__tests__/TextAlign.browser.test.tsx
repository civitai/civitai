import { generateJSON } from '@tiptap/html';
import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as Trpc from '~/utils/trpc';
import { tiptapExtensions } from '~/shared/tiptap/extensions';

// The editor reads stickers, blurbs and the signed-in user over tRPC for controls these tests
// never turn on. Stub the data hooks so it mounts without a network layer.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof Trpc>()), trpc: makeTrpcProxy({}) };
});
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => undefined }));
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  useOwnedSticker: () => ({ sticker: [] }),
}));

const { RichTextEditor } = await import('~/components/RichTextEditor/RichTextEditorComponent');
const { RenderRichText } = await import('~/components/RichTextEditor/RenderRichText');

const textAlignOf = (selector: string) => {
  const el = document.querySelector(selector);
  return el ? getComputedStyle(el).textAlign : null;
};

describe('text alignment control', () => {
  test('aligns the paragraph the cursor is in, and shows the current alignment', async () => {
    renderWithProviders(
      <RichTextEditor value="<p>hello</p>" includeControls={['heading', 'align']} editorSize="md" />
    );

    const text = page.getByText('hello');
    await expect.element(text).toBeInTheDocument();
    await userEvent.click(text);

    const button = page.getByRole('button', { name: 'Text alignment: Left' });
    await expect.element(button).toBeInTheDocument();
    await userEvent.click(button);
    await expect.element(page.getByText('Center')).toBeInTheDocument();
    await userEvent.click(page.getByRole('menuitem', { name: 'Center' }));

    await expect.poll(() => textAlignOf('.ProseMirror p')).toBe('center');
    await expect
      .element(page.getByRole('button', { name: 'Text alignment: Center' }))
      .toBeInTheDocument();

    await userEvent.click(page.getByRole('button', { name: 'Text alignment: Center' }));
    await expect
      .element(page.getByRole('menuitem', { name: 'Center' }))
      .toHaveAttribute('data-active', 'true');
    await userEvent.click(page.getByRole('menuitem', { name: 'Right' }));
    await expect.poll(() => textAlignOf('.ProseMirror p')).toBe('right');

    await userEvent.click(page.getByRole('button', { name: 'Text alignment: Right' }));
    await userEvent.click(page.getByRole('menuitem', { name: 'Left' }));
    await expect
      .element(page.getByRole('button', { name: 'Text alignment: Left' }))
      .toBeInTheDocument();
    expect(document.querySelector('.ProseMirror p')?.getAttribute('style')).toBeNull();
  });

  test('aligns a heading', async () => {
    renderWithProviders(
      <RichTextEditor value="<h2>title</h2>" includeControls={['heading', 'align']} />
    );

    await userEvent.click(page.getByText('title'));
    await userEvent.click(page.getByRole('button', { name: 'Text alignment: Left' }));
    await userEvent.click(page.getByRole('menuitem', { name: 'Center' }));

    await expect.poll(() => textAlignOf('.ProseMirror h2')).toBe('center');
  });

  test('is absent from an editor that did not ask for it', async () => {
    renderWithProviders(
      <RichTextEditor value="<p>hello</p>" includeControls={['heading', 'formatting']} />
    );

    await expect.element(page.getByText('hello')).toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: /Text alignment/ }))
      .not.toBeInTheDocument();
  });
});

describe('aligned article text', () => {
  test('renders a centered paragraph and heading from the stored document', async () => {
    const doc = generateJSON(
      '<h2 style="text-align:center">title</h2><p style="text-align:center">body</p><p>plain</p>',
      tiptapExtensions
    );

    renderWithProviders(
      <div data-testid="host">
        <RenderRichText content={doc} />
      </div>
    );

    await expect.element(page.getByText('body')).toBeInTheDocument();
    expect(textAlignOf('[data-testid="host"] h2')).toBe('center');
    expect(textAlignOf('[data-testid="host"] p')).toBe('center');
    expect(getComputedStyle(page.getByText('plain').element()).textAlign).not.toBe('center');
  });
});
