import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';

const { setText, addText, deleteText, setTexts, held, failure, inFlight } = vi.hoisted(() => ({
  inFlight: { never: 'resolves later' },
  failure: { data: { code: 'INTERNAL_SERVER_ERROR' }, message: 'boom' },
  setText: vi.fn(),
  addText: vi.fn(),
  deleteText: vi.fn(),
  setTexts: vi.fn(),
  held: { data: { code: 'FORBIDDEN' }, message: "This can't be removed right now." },
}));
type MutationOpts = { onSuccess?: (data: unknown) => void; onError?: (error: unknown) => void };

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  const { useState } = await import('react');
  // Stateful like react-query's: a failed create must stay failed until the next attempt.
  const mutation = (spy: typeof setText) => (opts: MutationOpts) => {
    const [status, setStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
    return {
      mutate: (input: unknown) => {
        const result = spy(input);
        if (result === inFlight) return setStatus('pending');
        if (result === held || result === failure) {
          setStatus('error');
          opts.onError?.(result);
        } else {
          setStatus('success');
          opts.onSuccess?.(result);
        }
      },
      reset: () => setStatus('idle'),
      isPending: status === 'pending',
      isSuccess: status === 'success',
      isError: status === 'error',
      isIdle: status === 'idle',
    };
  };
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'storyline.setText': { useMutation: mutation(setText) },
      'storyline.addText': { useMutation: mutation(addText) },
      'storyline.deleteText': { useMutation: mutation(deleteText) },
    }),
  };
});
vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({ setTexts, post: { id: 5 } }),
  usePendingSave: vi.fn(),
}));
// The real editor is TipTap behind next/dynamic; the card's contract is the HTML it hands back.
vi.mock('~/components/RichTextEditor/RichTextEditor', () => ({
  RichTextEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <div>
      <textarea aria-label="Text" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  ),
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showErrorNotification: vi.fn(),
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
    renderWithProviders(<StorylineTextCard text={text} label="Text 1 / 20" />);
    await page.getByLabelText('Text', { exact: true }).fill('<p>Once upon</p>');
    await expect.poll(() => setText.mock.calls.length, { timeout: 3000 }).toBe(1);
    expect(setText).toHaveBeenCalledWith({ id: 7, content: '<p>Once upon</p>' });
    // Past a second debounce window: still one save.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(setText).toHaveBeenCalledTimes(1);
    // The saved words go into this text, and only this one.
    const update = setTexts.mock.calls[0][0] as (t: (typeof text)[]) => (typeof text)[];
    const other = { id: 8, index: 2, content: '<p>Other</p>' };
    expect(update([text, other])).toEqual([{ ...text, content: '<p>Once upon</p>' }, other]);
  });

  test('a held text goes read-only with the server message, and offers no more edits', async () => {
    deleteText.mockReturnValue(held);
    renderWithProviders(<StorylineTextCard text={text} label="Text 1 / 20" />);
    await page.getByRole('button', { name: 'Delete text' }).click();
    await expect.element(page.getByRole('status')).toHaveTextContent(held.message);
    await expect.element(page.getByLabelText('Text', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Delete text' })).not.toBeInTheDocument();
    await expect.element(page.getByText('Once')).toBeVisible();
  });

  describe('a draft (Add text)', () => {
    const draft = (props = {}) => (
      <StorylineTextCard text={null} label="Text 1 / 20" draftIndex={4} {...props} />
    );

    test('makes no row until something is typed', async () => {
      addText.mockClear();
      renderWithProviders(draft());
      await expect.element(page.getByLabelText('Text', { exact: true })).toBeVisible();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(addText).not.toHaveBeenCalled();
    });

    test('whitespace alone does not create it', async () => {
      addText.mockClear();
      renderWithProviders(draft());
      await page.getByLabelText('Text', { exact: true }).fill('<p> </p>');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(addText).not.toHaveBeenCalled();
    });

    test('the first typed words create the row at its slot, then save those words', async () => {
      addText.mockReset();
      setText.mockReset();
      const created = { id: 31, index: 4, content: '' };
      addText.mockReturnValue(created);
      setText.mockImplementation(({ id, content }) => ({ id, content }));
      const onCreated = vi.fn();
      renderWithProviders(draft({ onCreated }));
      await page.getByLabelText('Text', { exact: true }).fill('<p>Once</p>');
      expect(addText).toHaveBeenCalledTimes(1);
      expect(addText).toHaveBeenCalledWith({ postId: 5, index: 4 });
      expect(onCreated).toHaveBeenCalledWith(created);
      expect(setText).toHaveBeenCalledWith({ id: 31, content: '<p>Once</p>' });
    });

    test('a failed create says so and the next keystroke tries again, with the latest words', async () => {
      addText.mockReset();
      setText.mockReset();
      addText.mockReturnValueOnce(failure).mockReturnValue({ id: 32, index: 4, content: '' });
      setText.mockImplementation(({ id, content }) => ({ id, content }));
      renderWithProviders(draft());
      const box = page.getByLabelText('Text', { exact: true });
      await box.fill('<p>O</p>');
      await expect.element(page.getByText('Not saved')).toBeVisible();
      await box.fill('<p>Once</p>');
      expect(addText).toHaveBeenCalledTimes(2);
      expect(setText).toHaveBeenCalledWith({ id: 32, content: '<p>Once</p>' });
    });

    test('Delete is off while the create is in flight, so the row cannot land after the card is gone', async () => {
      addText.mockReset();
      addText.mockReturnValue(inFlight);
      renderWithProviders(draft());
      await page.getByLabelText('Text', { exact: true }).fill('<p>Once</p>');
      await expect.element(page.getByRole('button', { name: 'Delete text' })).toBeDisabled();
    });

    test('Delete on an untouched draft dismisses it without a server call', async () => {
      deleteText.mockClear();
      const onDismiss = vi.fn();
      renderWithProviders(draft({ onDismiss }));
      await page.getByRole('button', { name: 'Delete text' }).click();
      expect(onDismiss).toHaveBeenCalledOnce();
      expect(deleteText).not.toHaveBeenCalled();
    });
  });

  test('words still inside the autosave pause are saved when the card goes away', async () => {
    setText.mockReset();
    setText.mockImplementation(({ id, content }) => ({ id, content }));
    const view = await renderWithProviders(<StorylineTextCard text={text} label="Text 1 / 20" />);
    await page.getByLabelText('Text', { exact: true }).fill('<p>Last words</p>');
    expect(setText).not.toHaveBeenCalled();
    await view.unmount();
    expect(setText).toHaveBeenCalledWith({ id: 7, content: '<p>Last words</p>' });
  });
});
