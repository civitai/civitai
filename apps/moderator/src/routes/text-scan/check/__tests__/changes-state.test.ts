import type { ActionResult } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOSAVE_MS,
  ChangesState,
  emptyChangesFields,
  submitSaved,
  type ChangesInit,
} from '../changes';

/**
 * The Check page's autosave over a faked action endpoint: what is posted, in what order, with which
 * conflict token — and what a late or refused answer may not do.
 */

const mine = (over: Partial<ChangesInit> = {}): ChangesInit => ({
  prompts: {},
  draftId: null,
  token: null,
  target: null,
  editable: true,
  ...over,
});

const saved = (draftId: number | null, updatedAt: string | null): ActionResult => ({
  type: 'success',
  status: 200,
  data: { draftId, updatedAt },
});

function deferred() {
  let resolve!: (r: ActionResult) => void;
  const promise = new Promise<ActionResult>((r) => (resolve = r));
  return { promise, resolve };
}

let post: ReturnType<typeof vi.fn>;
const make = (init = mine()) => new ChangesState(emptyChangesFields(), post as never, init);
const posted = (i: number) => post.mock.calls[i][1] as Record<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  post = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('autosave', () => {
  it('waits for typing to pause, then posts the latest text once', async () => {
    post.mockResolvedValue(saved(7, 'T1'));
    const changes = make();
    changes.set('base', 'B', 'CURRENT');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1);
    changes.set('base', 'BA', 'CURRENT');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1);
    expect(post).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('saveChanges');
    expect(posted(0)).toEqual({ prompts: JSON.stringify({ base: 'BA' }), expectedUpdatedAt: '' });
    expect(changes).toMatchObject({ token: 'T1', draftId: 7, dirty: false, error: null });
  });

  it('treats text equal to the current version as no change', async () => {
    post.mockResolvedValue(saved(null, null));
    const changes = make(mine({ prompts: { base: 'MINE' }, draftId: 7, token: 'T0' }));
    changes.set('base', 'CURRENT', 'CURRENT');
    expect(changes.keys).toEqual([]);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(posted(0)).toEqual({ prompts: '{}', expectedUpdatedAt: 'T0' });
  });

  it('runs saves one at a time, each sending the token the previous one returned', async () => {
    const first = deferred();
    post.mockReturnValueOnce(first.promise).mockResolvedValueOnce(saved(7, 'T2'));
    const changes = make();
    changes.set('base', 'ONE', undefined);
    const one = changes.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(posted(0).prompts).toBe(JSON.stringify({ base: 'ONE' }));
    changes.set('base', 'TWO', undefined);
    const two = changes.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1);

    first.resolve(saved(7, 'T1'));
    expect(await one).toBe(true);
    expect(await two).toBe(true);
    expect(post).toHaveBeenCalledTimes(2);
    expect(posted(1)).toEqual({
      prompts: JSON.stringify({ base: 'TWO' }),
      expectedUpdatedAt: 'T1',
    });
    expect(changes.token).toBe('T2');
  });

  it("names the author's proposed draft when editing one", async () => {
    post.mockResolvedValue(saved(5, 'T1'));
    const changes = make(mine({ target: 5, draftId: 5, token: 'T0' }));
    changes.set('base', 'B', undefined);
    await changes.flush();
    expect(posted(0)).toMatchObject({ draftId: '5', expectedUpdatedAt: 'T0' });
  });

  it('refuses a blank key by its friendly name without posting', async () => {
    const changes = make();
    changes.set('label:scam', '  ', 'SCAM DEF');
    expect(await changes.flush()).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(changes.error).toBe(
      'Scam / phishing definition is empty — write it, or reset it to current.'
    );
  });

  it('stops saving after a conflict until the page reloads', async () => {
    post.mockResolvedValue({
      type: 'failure',
      status: 409,
      data: { error: 'Your changes were changed in another tab — reload to see the latest.' },
    });
    const changes = make();
    changes.set('base', 'A', undefined);
    expect(await changes.flush()).toBe(false);
    expect(changes.conflict).toBe(true);

    changes.set('base', 'B', undefined);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(await changes.flush()).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);

    changes.reset(mine({ prompts: { base: 'THEIRS' }, draftId: 7, token: 'T9' }));
    expect(changes).toMatchObject({ conflict: false, error: null, dirty: false });
  });

  it('drops a save answered after a reset, leaving the new state alone', async () => {
    const late = deferred();
    post.mockReturnValueOnce(late.promise);
    const changes = make();
    changes.set('base', 'OLD', undefined);
    const flushing = changes.flush();
    await vi.advanceTimersByTimeAsync(0);

    changes.reset(mine({ prompts: { base: 'NEW' }, draftId: 9, token: 'T9' }));
    late.resolve(saved(7, 'T1'));
    expect(await flushing).toBe(false);
    expect(changes).toMatchObject({ token: 'T9', draftId: 9, saving: false, dirty: false });
  });

  it('cancels a pending autosave on settle', async () => {
    const changes = make();
    changes.set('base', 'B', undefined);
    await changes.settle();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);
    expect(post).not.toHaveBeenCalled();
  });

  it('passes keepalive through for a save started as the page unloads', async () => {
    post.mockResolvedValue(saved(7, 'T1'));
    const changes = make();
    changes.set('base', 'B', undefined);
    await changes.flush({ keepalive: true });
    expect(post.mock.calls[0][2]).toEqual({ keepalive: true });
  });
});

describe('submitSaved (Propose, Publish)', () => {
  const form = () => {
    const f = {
      submitting: false,
      error: null as string | null,
      enhance: vi.fn((): undefined => undefined),
    };
    return f;
  };
  const submit = () => {
    const formData = new FormData();
    const cancel = vi.fn();
    return { input: { formData, cancel } as never, formData, cancel };
  };

  it('saves first, then submits the id and token of what was saved, without dropping submitting', async () => {
    const answer = deferred();
    post.mockReturnValueOnce(answer.promise);
    const changes = make();
    changes.set('base', 'B', undefined);
    const f = form();
    const { input, formData, cancel } = submit();

    const running = submitSaved(changes, f)(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.submitting).toBe(true);
    expect(f.enhance).not.toHaveBeenCalled();

    answer.resolve(saved(7, 'T1'));
    await running;
    expect(f.enhance).toHaveBeenCalledTimes(1);
    expect(f.submitting).toBe(true);
    expect(formData.get('draftId')).toBe('7');
    expect(formData.get('expectedUpdatedAt')).toBe('T1');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels with the save refusal when the changes cannot be saved', async () => {
    const changes = make();
    changes.set('base', ' ', undefined);
    const f = form();
    const { input, cancel } = submit();
    await submitSaved(changes, f)(input);
    expect(cancel).toHaveBeenCalled();
    expect(f.enhance).not.toHaveBeenCalled();
    expect(f).toMatchObject({
      submitting: false,
      error: 'General instructions is empty — write it, or reset it to current.',
    });
  });

  it('cancels when there is nothing saved to send', async () => {
    const changes = make();
    const f = form();
    const { input, cancel } = submit();
    await submitSaved(changes, f)(input);
    expect(cancel).toHaveBeenCalled();
    expect(f.error).toBe('There are no changes to send.');
  });
});
