import { describe, expect, test, vi } from 'vitest';
import {
  KEEPALIVE_MIN_INTERVAL_MS,
  VIEWER_BRIDGE_TYPES,
  createKeepAlive,
  isViewerBridgeMessage,
  pingSandbox,
} from '~/components/Apps/AppAssistant/previewKeepAlive';

describe('isViewerBridgeMessage', () => {
  test('exactly the requests an app makes because its viewer did something count', () => {
    expect([...VIEWER_BRIDGE_TYPES].sort()).toEqual([
      'APP_STORAGE_DELETE',
      'APP_STORAGE_SET',
      'CANCEL_APP_WORKFLOW',
      'CANCEL_WORKFLOW',
      'CREATE_POST_FROM_APP',
      'ESTIMATE_WORKFLOW',
      'ESTIMATE_WORKFLOW_BATCH',
      'NAVIGATE',
      'OPEN_BUZZ_PURCHASE',
      'OPEN_CHECKPOINT_PICKER',
      'OPEN_IMAGE_PICKER',
      'OPEN_IMAGE_UPLOAD',
      'OPEN_MEDIA_UPLOAD',
      'OPEN_RESOURCE_PICKER',
      'PREPARE_TRAINING_DATASET',
      'PUBLISH_GENERATION_OUTPUTS',
      'REQUEST_CONSENT',
      'REQUEST_SIGN_IN',
      'RUN_CONFIRMED_STEP',
      'RUN_TRAINING',
      'SAVE_IMAGE',
      'SET_COLLECTION_FOLLOW',
      'SET_ENTITY_REACTION',
      'SET_USER_CHECKPOINT',
      'SHARED_APPEND',
      'SHARED_REPORT',
      'SHARED_UNVOTE',
      'SHARED_UPDATE',
      'SHARED_VOTE',
      'SHARED_WITHDRAW',
      'SUBMIT_WORKFLOW',
      'VIEWER_ACTIVITY',
    ]);
    for (const type of VIEWER_BRIDGE_TYPES)
      expect(isViewerBridgeMessage({ type, requestId: 'r1' })).toBe(true);
  });

  test('what an app sends by itself, reads it can make on a timer, and unknown types do not', () => {
    for (const type of [
      'BLOCK_HELLO',
      'BLOCK_READY',
      'BLOCK_ERROR',
      'BLOCK_MESSAGE_REJECTED',
      'RESIZE_IFRAME',
      'REQUEST_TOKEN',
      'TRACK_EVENT',
      'POLL_WORKFLOW',
      'QUERY_APP_WORKFLOWS',
      'GET_BUZZ_BALANCE',
      'GET_VIEWER',
      'APP_STORAGE_GET',
      'APP_STORAGE_LIST',
      'SHARED_LIST',
      'GET_IMAGES_BY_IDS',
      'SOME_FUTURE_TYPE',
    ])
      expect(isViewerBridgeMessage({ type, requestId: 'r1' })).toBe(false);
  });

  test('anything not shaped like a bridge message does not', () => {
    for (const data of [null, undefined, 'SUBMIT_WORKFLOW', 7, {}, { type: '' }, { type: 3 }])
      expect(isViewerBridgeMessage(data)).toBe(false);
  });
});

describe('createKeepAlive', () => {
  test('the interval is one minute', () => {
    expect(KEEPALIVE_MIN_INTERVAL_MS).toBe(60_000);
  });

  test('pings on the first activity, then at most once per interval', () => {
    let t = 1_000_000;
    const ping = vi.fn().mockResolvedValue(true);
    const k = createKeepAlive({ ping, isShown: () => true, now: () => t });

    expect(k.activity()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(1);

    t += 25_000; // mid-interval
    expect(k.activity()).toBe(false);
    t += 34_999; // 59 999 ms after the ping
    expect(k.activity()).toBe(false);
    expect(ping).toHaveBeenCalledTimes(1);

    t += 1; // exactly one interval
    expect(k.activity()).toBe(true);
    t += 90_000; // well past the next one
    expect(k.activity()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(3);
  });

  test('a custom interval is honoured', () => {
    let t = 0;
    const ping = vi.fn().mockResolvedValue(true);
    const k = createKeepAlive({ ping, isShown: () => true, now: () => t, minIntervalMs: 7_000 });
    k.activity();
    t = 6_999;
    expect(k.activity()).toBe(false);
    t = 7_000;
    expect(k.activity()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  test('nothing while the pane is not shown, and that does not use up the interval', () => {
    let shown = false;
    const t = 5_000_000;
    const ping = vi.fn().mockResolvedValue(true);
    const k = createKeepAlive({ ping, isShown: () => shown, now: () => t });

    expect(k.activity()).toBe(false);
    expect(k.activity()).toBe(false);
    expect(ping).not.toHaveBeenCalled();

    shown = true;
    expect(k.activity()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  test('a failed ping is dropped, and the next activity past the interval tries again', async () => {
    let t = 0;
    const ping = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('no token'))
      .mockResolvedValue(true);
    const k = createKeepAlive({ ping, isShown: () => true, now: () => t });
    expect(k.activity()).toBe(true);
    await Promise.resolve();
    t = 61_000;
    expect(k.activity()).toBe(true);
    t = 122_000;
    expect(k.activity()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(3);
  });
});

describe('pingSandbox', () => {
  const MCP_URL = 'https://sandbox.example/s/sbx-aaaaaaaaaaaa/mcp';
  const ok = () => new Response('{"jsonrpc":"2.0","id":"keepalive","result":{}}', { status: 200 });

  test('sends one MCP ping to the app, with the user’s sandbox token', async () => {
    const getToken = vi.fn().mockResolvedValue('tok-1');
    const fetchImpl = vi.fn().mockResolvedValue(ok());

    await pingSandbox(MCP_URL, getToken, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(MCP_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      authorization: 'Bearer tok-1',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      jsonrpc: '2.0',
      id: 'keepalive',
      method: 'ping',
    });
    expect(getToken).toHaveBeenCalledWith(undefined);
  });

  test('after a 401 asks for a fresh token once and tries again', async () => {
    const getToken = vi.fn().mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(ok());

    await pingSandbox(MCP_URL, getToken, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenLastCalledWith({ refresh: true });
    expect((fetchImpl.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer fresh',
    });
  });

  test('NEGATIVE CONTROL: a second 401 is not retried again, and any other refusal not at all', async () => {
    const getToken = vi.fn().mockResolvedValue('tok');
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    await pingSandbox(MCP_URL, getToken, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const down = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    await pingSandbox(MCP_URL, getToken, down);
    expect(down).toHaveBeenCalledTimes(1);
  });
});
