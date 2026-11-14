import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as TrpcModule from '~/utils/trpc';

const { setText, deleteText, setTexts, held } = vi.hoisted(() => ({
  setText: vi.fn(),
  deleteText: vi.fn(),
  setTexts: vi.fn(),
  held: { data: { code: 'FORBIDDEN' }, message: "This can't be removed right now." },
}));
type MutationOpts = { onSuccess?: (data: unknown) => void; onError?: (error: unknown) => void };

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  const mutation = (spy: typeof setText) => (opts: MutationOpts) => ({
    mutate: (input: unknown) => {
      const result = spy(input);
      if (result === held) opts.onError?.(result);
      else opts.onSuccess?.(result);
    },
    reset: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
  });
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'storyline.setText': { useMutation: mutation(setText) },
      'storyline.deleteText': { useMutation: mutation(deleteText) },
    }),
  };
});
vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) => selector({ setTexts }),
  usePendingSave: vi.fn(),
}));
// The real editor is TipTap behind next/dynamic; the card's contract is the HTML it hands back.
vi.mock('~/components/RichTextEditor/RichTextEditor', () => ({
  RichTextEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="Text" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock('~/components/RenderHtml/RenderHtml', () => ({
  RenderHtml: ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />,
}));

// eslint-disable-next-line import/first
import { StorylineTextCard } from '~/components/Storyline/editor/StorylineTextCard';

const text = { id: 7, index: 1, content: '<p>Once</p>' };

describe('StorylineTextCard', () => {
  test('autosaves what the author typed, once, after the pause', async () => {
    setText.mockImplementation(({ id, content }) => ({ id, content }));
    renderWithProviders(<StorylineTextCard text={text} />);
    await page.getByLabelText('Text', { exact: true }).fill('<p>Once upon</p>');
    await expect.poll(() => setText.mock.calls.length, { timeout: 3000 }).toBe(1);
    expect(setText).toHaveBeenCalledWith({ id: 7, content: '<p>Once upon</p>' });
    expect(setTexts).toHaveBeenCalled();
  });

  test('a held text goes read-only with the server message, and offers no more edits', async () => {
    deleteText.mockReturnValue(held);
    renderWithProviders(<StorylineTextCard text={text} />);
    await page.getByRole('button', { name: 'Delete text' }).click();
    await expect.element(page.getByRole('status')).toHaveTextContent(held.message);
    await expect.element(page.getByLabelText('Text', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Delete text' })).not.toBeInTheDocument();
    await expect.element(page.getByText('Once')).toBeVisible();
  });
});
