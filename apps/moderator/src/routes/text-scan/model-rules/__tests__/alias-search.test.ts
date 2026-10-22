import { describe, expect, it, vi } from 'vitest';
import { searchAliases, type PollAnswer, type SearchAnswer } from '../alias-search';

const SUGGESTIONS = [{ alias: 'One Name', kind: 'stage_name' as const }];
const done: PollAnswer = { status: 'done', suggestions: SUGGESTIONS, costTotal: 3 };
const pending: PollAnswer = { status: 'pending' };

/** A clock the fake sleep advances, so the cap is tested without waiting. */
function harness(over: Partial<Parameters<typeof searchAliases>[0]> = {}) {
  let clock = 0;
  const submit = vi.fn<() => Promise<SearchAnswer>>(async () => ({
    status: 'pending',
    workflowId: 'wf_0123456789',
  }));
  const poll = vi.fn<(id: string) => Promise<PollAnswer>>(async () => done);
  const onWorkflowId = vi.fn();
  const options = {
    submit,
    poll,
    onWorkflowId,
    intervalMs: 1000,
    maxWaitMs: 10_000,
    now: () => clock,
    sleep: async (ms: number) => void (clock += ms),
    ...over,
  };
  return { options, submit, poll, onWorkflowId, run: () => searchAliases(options) };
}

describe('searchAliases', () => {
  it('stores the workflow id as soon as it is returned, then polls until done', async () => {
    const h = harness();
    h.poll.mockResolvedValueOnce(pending).mockResolvedValueOnce(done);
    const order: string[] = [];
    h.onWorkflowId.mockImplementation(() => order.push('stored'));
    h.poll.mockImplementation(async () => {
      order.push('poll');
      return order.filter((o) => o === 'poll').length < 2 ? pending : done;
    });

    expect(await h.run()).toEqual({ status: 'done', suggestions: SUGGESTIONS, costTotal: 3 });
    expect(h.onWorkflowId).toHaveBeenCalledExactlyOnceWith('wf_0123456789');
    expect(order[0]).toBe('stored');
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it('skips polling when the submit already finished', async () => {
    const h = harness();
    h.submit.mockResolvedValue({ status: 'done', suggestions: SUGGESTIONS });
    expect(await h.run()).toEqual({ status: 'done', suggestions: SUGGESTIONS });
    expect(h.poll).not.toHaveBeenCalled();
    expect(h.onWorkflowId).not.toHaveBeenCalled();
  });

  it('resumes a stored workflow without submitting again', async () => {
    const h = harness({ workflowId: 'wf_stored_0001' });
    expect(await h.run()).toMatchObject({ status: 'done' });
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.poll).toHaveBeenCalledWith('wf_stored_0001');
  });

  it('reports a failed search so the caller can drop the id and allow a re-submit', async () => {
    const h = harness({ workflowId: 'wf_stored_0001' });
    h.poll.mockResolvedValue({ status: 'failed', error: 'workflow failed' });
    expect(await h.run()).toEqual({ status: 'failed', error: 'workflow failed' });
  });

  it('gives up polling at the cap but keeps the search, never re-submitting', async () => {
    const h = harness();
    h.poll.mockResolvedValue(pending);
    const outcome = await h.run();
    expect(outcome.status).toBe('unresolved');
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.poll.mock.calls.length).toBeGreaterThanOrEqual(9);
    expect(h.poll.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it('tolerates a transient poll error and keeps polling', async () => {
    const h = harness({ workflowId: 'wf_stored_0001' });
    h.poll.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(done);
    expect(await h.run()).toMatchObject({ status: 'done' });
  });

  it('stops trusting the connection after repeated poll errors, but keeps the search', async () => {
    const h = harness({ workflowId: 'wf_stored_0001' });
    h.poll.mockRejectedValue(new Error('network'));
    const outcome = await h.run();
    expect(outcome).toMatchObject({ status: 'unresolved' });
    expect(h.poll).toHaveBeenCalledTimes(3);
  });

  it('stops polling when aborted and reports stopped', async () => {
    const controller = new AbortController();
    const h = harness({ workflowId: 'wf_stored_0001', signal: controller.signal });
    h.poll.mockImplementation(async () => {
      controller.abort();
      return pending;
    });
    expect(await h.run()).toEqual({ status: 'stopped' });
    expect(h.poll).toHaveBeenCalledTimes(1);
  });

  it('does not submit when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ signal: controller.signal });
    expect(await h.run()).toEqual({ status: 'stopped' });
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('lets a submit error through: nothing was billed or stored', async () => {
    const h = harness();
    h.submit.mockRejectedValue(new Error('refused'));
    await expect(h.run()).rejects.toThrow('refused');
    expect(h.onWorkflowId).not.toHaveBeenCalled();
  });
});
