import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logToAxiom } = vi.hoisted(() => ({ logToAxiom: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({ env: { SIGNALS_ENDPOINT: 'https://signals.test' } }));
vi.mock('../settings/runtime', () => ({ storedSettings: async () => ({}) }));
vi.mock('../axiom', () => ({ logToAxiom }));

const { getSignalsAccessToken, sendTopic, sendToUser } = await import('./signals');

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  logToAxiom.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const failure = () => logToAxiom.mock.calls.map(([event]) => event);

describe('signal service failures reach Axiom', () => {
  it('logs a topic send the service refuses, and still never throws', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    await expect(
      sendTopic('knights-queue:Knight', 'knights-queue-drop', {})
    ).resolves.toBeUndefined();
    expect(failure()).toEqual([
      expect.objectContaining({
        type: 'error',
        name: 'knights-live-update-failed',
        details: expect.objectContaining({
          path: '/topics/knights-queue%3AKnight/signals/knights-queue-drop',
          status: 503,
        }),
      }),
    ]);
  });

  it('logs a user send that cannot reach the service', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(sendToUser(7, 'knights-player', {})).resolves.toBeUndefined();
    expect(failure()).toEqual([
      expect.objectContaining({
        type: 'error',
        name: 'knights-live-update-failed',
        details: expect.objectContaining({
          path: '/users/7/signals/knights-player',
          error: 'connect ECONNREFUSED',
        }),
      }),
    ]);
  });

  it('logs a token the service will not mint, and the page gets none', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));
    expect(await getSignalsAccessToken(7)).toBeNull();
    expect(failure()).toEqual([
      expect.objectContaining({
        type: 'error',
        name: 'knights-live-token-failed',
        details: expect.objectContaining({ userId: 7, status: 500 }),
      }),
    ]);
  });

  it('logs nothing when a send succeeds', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 202 }));
    await sendTopic('knights-queue:Knight', 'knights-queue-drop', {});
    expect(logToAxiom).not.toHaveBeenCalled();
  });
});
