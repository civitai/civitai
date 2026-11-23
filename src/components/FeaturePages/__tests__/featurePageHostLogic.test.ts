import { describe, expect, it, vi } from 'vitest';
import { createFeaturePageHost } from '../featurePageHostLogic';

const ORIGIN = 'https://features.example.com';
const REQUEST = 'urn:data.civitai.com:feature-pages/requests/dark-mode';

function setup(
  overrides: {
    signedIn?: boolean;
    vote?: () => Promise<{ votes: number }>;
    mine?: () => Promise<{ votes: Record<string, 0 | 1> }>;
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
    navigate: vi.fn(),
  };
  const host = createFeaturePageHost(deps);
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
  it('casts a vote from its frame and answers that frame with the tally', async () => {
    const { frame, deps, send, flush } = setup();
    send(vote);
    await flush();
    expect(deps.vote).toHaveBeenCalledWith({ request: REQUEST, value: 1 });
    expect(frame.postMessage).toHaveBeenCalledWith(
      { type: 'fp-vote-result', payload: { requestId: 'r1', ok: true, votes: 5 } },
      ORIGIN
    );
  });

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

  it('answers ready with the theme and feature', () => {
    const { frame, deps, send } = setup();
    send({ type: 'fp-ready' });
    expect(frame.postMessage).toHaveBeenCalledWith(
      { type: 'fp-init', payload: { theme: 'dark', feature: deps.feature } },
      ORIGIN
    );
  });
});
