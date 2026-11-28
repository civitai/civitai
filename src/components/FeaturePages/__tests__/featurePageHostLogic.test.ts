import { describe, expect, it, vi } from 'vitest';
import { createFeaturePageHost } from '../featurePageHostLogic';
import { FEATURE_PAGES_SET_USERNAME_MESSAGE } from '~/shared/constants/feature-pages.constants';

const ORIGIN = 'https://features.example.com';
const REQUEST = 'urn:data.civitai.com:feature-pages/requests/dark-mode';

function setup(
  overrides: {
    signedIn?: boolean;
    vote?: () => Promise<{ votes: number }>;
    mine?: () => Promise<{ votes: Record<string, 0 | 1> }>;
    /** Leave the frame without its fp-init, as before the host first sends it. */
    uninitialised?: boolean;
    discussion?: boolean;
    viewerAuthor?: string | null;
  } = {}
) {
  const frame = { postMessage: vi.fn() };
  const deps = {
    embedOrigin: ORIGIN,
    feature: 'urn:data.civitai.com:feature-pages/features/dark-mode',
    frameWindow: () => frame as unknown as Window,
    theme: 'dark' as const,
    signedIn: overrides.signedIn ?? true,
    openLogin: vi.fn(),
    vote: vi.fn(overrides.vote ?? (async () => ({ votes: 5 }))),
    mine: vi.fn(overrides.mine ?? (async () => ({ votes: { [REQUEST]: 1 as const } }))),
    maskProfanity: true,
    discussion: overrides.discussion ?? true,
    viewerAuthor: overrides.viewerAuthor ?? null,
    comment: vi.fn(async () => ({ comment: { urn: 'urn:data.civitai.com:c1', text: 'hi' } })),
    editComment: vi.fn(async () => ({ comment: { urn: 'urn:data.civitai.com:c1', text: 'hi!' } })),
    retractComment: vi.fn(async () => ({ comment: 'urn:data.civitai.com:c1' })),
    reportComment: vi.fn(async () => ({ comment: 'urn:data.civitai.com:c1' })),
    navigate: vi.fn(),
  };
  const host = createFeaturePageHost(deps);
  // The component sends fp-init as it mounts.
  if (!overrides.uninitialised) {
    host.sendInit();
    frame.postMessage.mockClear();
  }
  const send = (data: unknown, from: { origin?: string; source?: unknown } = {}) =>
    host.onMessage({
      origin: from.origin ?? ORIGIN,
      source: (from.source ?? frame) as Window,
      data,
    });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { frame, deps, send, flush };
}

const vote = { type: 'fp-vote', payload: { requestId: 'r1', request: REQUEST, value: 1 } };

describe('feature page host messages', () => {
  it.each([true, false])(
    'casts a vote from its frame and answers that frame with the tally (discussion %s)',
    async (discussion) => {
      const { frame, deps, send, flush } = setup({ discussion });
      send(vote);
      await flush();
      expect(deps.vote).toHaveBeenCalledWith({ request: REQUEST, value: 1 });
      expect(frame.postMessage).toHaveBeenCalledWith(
        { type: 'fp-vote-result', payload: { requestId: 'r1', ok: true, votes: 5 } },
        ORIGIN
      );
    }
  );

  it('ignores a vote from another window or another origin', async () => {
    const { frame, deps, send, flush } = setup();
    send(vote, { source: {} });
    send(vote, { origin: 'https://civitai.com' });
    send(vote, { origin: 'null' });
    await flush();
    expect(deps.vote).not.toHaveBeenCalled();
    expect(frame.postMessage).not.toHaveBeenCalled();
  });

  it('opens login instead of voting when signed out', () => {
    const { frame, deps, send } = setup({ signedIn: false });
    send(vote);
    expect(deps.openLogin).toHaveBeenCalledOnce();
    expect(deps.vote).not.toHaveBeenCalled();
    expect(frame.postMessage).toHaveBeenCalledWith(
      { type: 'fp-vote-result', payload: { requestId: 'r1', ok: false, error: 'sign_in' } },
      ORIGIN
    );
  });

  it("reads the viewer's own votes and answers with them", async () => {
    const { frame, deps, send, flush } = setup();
    send({ type: 'fp-mine', payload: { requestId: 'm1', requests: [REQUEST] } });
    await flush();
    expect(deps.mine).toHaveBeenCalledWith({ requests: [REQUEST] });
    expect(frame.postMessage).toHaveBeenCalledWith(
      { type: 'fp-mine-result', payload: { requestId: 'm1', ok: true, votes: { [REQUEST]: 1 } } },
      ORIGIN
    );
  });

  it('answers a signed-out read of own votes with sign_in, without reading', () => {
    const { frame, deps, send } = setup({ signedIn: false });
    send({ type: 'fp-mine', payload: { requestId: 'm1', requests: [REQUEST] } });
    expect(deps.mine).not.toHaveBeenCalled();
    expect(deps.openLogin).not.toHaveBeenCalled();
    expect(frame.postMessage).toHaveBeenCalledWith(
      { type: 'fp-mine-result', payload: { requestId: 'm1', ok: false, error: 'sign_in' } },
      ORIGIN
    );
  });

  // A TRPCClientError carries the server's code at `.data.code`.
  it.each([
    [{ data: { code: 'FORBIDDEN' } }, 'refused'],
    [{ data: { code: 'UNAUTHORIZED' } }, 'sign_in'],
    [new TypeError('network'), 'try_again'],
  ])('reports a failed vote (%o) as %s', async (error, expected) => {
    const { frame, send, flush } = setup({ vote: () => Promise.reject(error) });
    send(vote);
    await flush();
    expect(frame.postMessage).toHaveBeenCalledWith(
      { type: 'fp-vote-result', payload: { requestId: 'r1', ok: false, error: expected } },
      ORIGIN
    );
  });

  it('reports a failed read of own votes on the mine result', async () => {
    const { frame, send, flush } = setup({
      mine: () => Promise.reject({ data: { code: 'FORBIDDEN' } }),
    });
    send({ type: 'fp-mine', payload: { requestId: 'm1', requests: [REQUEST] } });
    await flush();
    expect(frame.postMessage).toHaveBeenCalledWith(
      { type: 'fp-mine-result', payload: { requestId: 'm1', ok: false, error: 'refused' } },
      ORIGIN
    );
  });

  it('navigates the page to a site path and refuses another site', () => {
    const { deps, send } = setup();
    send({ type: 'NAVIGATE', payload: { path: '/models/1', scope: 'site' } });
    send({ type: 'NAVIGATE', payload: { path: 'https://evil.example/x', scope: 'site' } });
    send({ type: 'NAVIGATE', payload: { path: '//evil.example/x', scope: 'site' } });
    expect(deps.navigate).toHaveBeenCalledOnce();
    expect(deps.navigate.mock.calls[0][0]).toMatchObject({ href: '/models/1', target: 'current' });
  });

  it.each([true, false])(
    'answers ready with the theme, feature, the mask setting, and comments only with featurePagesDiscussion (%s)',
    (discussion) => {
      const { frame, deps, send } = setup({ discussion });
      send({ type: 'fp-ready' });
      expect(frame.postMessage).toHaveBeenCalledWith(
        {
          type: 'fp-init',
          payload: {
            theme: 'dark',
            feature: deps.feature,
            capabilities: { comments: discussion, edit: discussion },
            maskProfanity: true,
          },
        },
        ORIGIN
      );
    }
  );

  it('names the viewer by their platform handle when there is one', () => {
    const author = `h1:${'a'.repeat(64)}`;
    const { frame, send } = setup({ viewerAuthor: author });
    send({ type: 'fp-ready' });
    expect(frame.postMessage.mock.calls[0][0].payload.viewer).toEqual({ author });
  });
});

describe('feature page comments', () => {
  const comment = {
    type: 'fp-comment',
    payload: { requestId: 'c1', subject: REQUEST, text: 'hi' },
  };

  it('a refusal for want of a username is refused to the frame, and the page is told', async () => {
    const { frame, deps, send, flush } = setup();
    const onNeedsUsername = vi.fn();
    Object.assign(deps, { onNeedsUsername });
    deps.comment.mockRejectedValueOnce(
      Object.assign(new Error(FEATURE_PAGES_SET_USERNAME_MESSAGE), {
        data: { code: 'PRECONDITION_FAILED' },
      })
    );
    send(comment);
    await flush();
    expect(onNeedsUsername).toHaveBeenCalledOnce();
    expect(frame.postMessage).toHaveBeenLastCalledWith(
      { type: 'fp-comment-result', payload: { requestId: 'c1', ok: false, error: 'refused' } },
      ORIGIN
    );
    // Any other refusal tells the page nothing.
    deps.comment.mockRejectedValueOnce(
      Object.assign(new Error('Refused'), { data: { code: 'FORBIDDEN' } })
    );
    send(comment);
    await flush();
    expect(onNeedsUsername).toHaveBeenCalledOnce();
  });

  it('answers try_again before fp-init without calling anything, and posts once after it', async () => {
    const { frame, deps, send, flush } = setup({ uninitialised: true });
    send(comment);
    send(vote);
    await flush();
    expect(deps.comment).not.toHaveBeenCalled();
    expect(deps.vote).not.toHaveBeenCalled();
    expect(frame.postMessage.mock.calls).toEqual([
      [
        { type: 'fp-comment-result', payload: { requestId: 'c1', ok: false, error: 'try_again' } },
        ORIGIN,
      ],
      [
        { type: 'fp-vote-result', payload: { requestId: 'r1', ok: false, error: 'try_again' } },
        ORIGIN,
      ],
    ]);
    send({ type: 'fp-ready' });
    send(comment);
    await flush();
    expect(deps.comment).toHaveBeenCalledOnce();
    expect(deps.comment).toHaveBeenCalledWith({
      requestId: 'c1',
      subject: REQUEST,
      parent: undefined,
      text: 'hi',
    });
    expect(frame.postMessage).toHaveBeenLastCalledWith(
      {
        type: 'fp-comment-result',
        payload: {
          requestId: 'c1',
          ok: true,
          comment: { urn: 'urn:data.civitai.com:c1', text: 'hi' },
        },
      },
      ORIGIN
    );
  });

  it.each([
    ['blocked', 'UNPROCESSABLE_CONTENT'],
    ['refused', 'FORBIDDEN'],
    ['refused', 'BAD_REQUEST'],
    ['try_again', 'INTERNAL_SERVER_ERROR'],
  ])('answers %s when the server answers %s', async (error, code) => {
    const { frame, deps, send, flush } = setup();
    deps.comment.mockRejectedValueOnce({ data: { code } });
    send(comment);
    await flush();
    expect(frame.postMessage).toHaveBeenCalledWith(
      { type: 'fp-comment-result', payload: { requestId: 'c1', ok: false, error } },
      ORIGIN
    );
  });

  it('opens login instead of posting when signed out', () => {
    const { frame, deps, send } = setup({ signedIn: false });
    send(comment);
    expect(deps.openLogin).toHaveBeenCalledOnce();
    expect(deps.comment).not.toHaveBeenCalled();
    expect(frame.postMessage).toHaveBeenCalledWith(
      { type: 'fp-comment-result', payload: { requestId: 'c1', ok: false, error: 'sign_in' } },
      ORIGIN
    );
  });

  it('routes an edit, a retract and a report to their calls, and ignores an unknown type', async () => {
    const { frame, deps, send, flush } = setup();
    const urn = 'urn:data.civitai.com:c1';
    send({ type: 'fp-comment-edit', payload: { requestId: 'e1', comment: urn, text: 'hi!' } });
    send({ type: 'fp-comment-retract', payload: { requestId: 'x1', comment: urn } });
    send({ type: 'fp-comment-report', payload: { requestId: 'p1', comment: urn, reason: 'Spam' } });
    send({ type: 'constructor', payload: { requestId: 'z1' } });
    await flush();
    expect(deps.editComment).toHaveBeenCalledWith({ requestId: 'e1', comment: urn, text: 'hi!' });
    expect(deps.retractComment).toHaveBeenCalledWith({ requestId: 'x1', comment: urn });
    expect(deps.reportComment).toHaveBeenCalledWith({
      comment: urn,
      reason: 'Spam',
      details: undefined,
    });
    for (const call of [deps.editComment, deps.retractComment, deps.reportComment])
      expect(call).toHaveBeenCalledOnce();
    expect(deps.comment).not.toHaveBeenCalled();
    expect(frame.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ requestId: 'z1' }) }),
      expect.anything()
    );
  });
});
