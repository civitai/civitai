import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same transport mocks as safe-fetch.test.ts: DNS and node:https are driven per test,
// so no socket is ever opened and a test can say which address a host resolves to.
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ default: { request: requestMock } }));

import { lookup } from 'node:dns/promises';
import { SafeFetchError } from '~/server/utils/safe-fetch';
import { safeUnfurl } from '~/server/utils/safe-unfurl';

const lookupMock = vi.mocked(lookup);

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const PRIVATE = [{ address: '10.0.0.5', family: 4 }];

/** Answer each request with the next response; records the URL of every request made. */
let requested: string[] = [];
function primeTransport(...responses: { type: string; body: string }[]) {
  let i = 0;
  requestMock.mockImplementation(
    (options: { protocol: string; hostname: string; path: string }, cb: (res: unknown) => void) => {
      requested.push(`${options.protocol}//${options.hostname}${options.path}`);
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => {
        const r = responses[i++];
        const res = Object.assign(Readable.from([Buffer.from(r.body)]), {
          statusCode: 200,
          headers: { 'content-type': r.type },
        });
        queueMicrotask(() => cb(res));
      };
      return req;
    }
  );
}

async function errorCode(p: Promise<unknown>) {
  try {
    await p;
    return '<<no-throw>>';
  } catch (e) {
    return e instanceof SafeFetchError ? e.code : `other: ${(e as Error)?.message}`;
  }
}

beforeEach(() => {
  requestMock.mockReset();
  lookupMock.mockReset();
  requested = [];
});

describe('safeUnfurl', () => {
  it('refuses a host that resolves to a private address, before any request', async () => {
    lookupMock.mockResolvedValue(PRIVATE as never);
    expect(await errorCode(safeUnfurl('https://github.com/civitai'))).toBe('blocked_host');
    expect(lookupMock).toHaveBeenCalledWith('github.com', { all: true });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('reads the preview of a page on a public address', async () => {
    lookupMock.mockResolvedValue(PUBLIC as never);
    primeTransport({
      type: 'text/html; charset=utf-8',
      body: '<html><head><title>Civitai</title><meta property="og:title" content="Repo" /></head></html>',
    });
    const data = await safeUnfurl('https://github.com/civitai');
    expect(data.title).toBe('Civitai');
    expect(data.open_graph?.title).toBe('Repo');
  });

  it('fetches an http:// link over https', async () => {
    lookupMock.mockResolvedValue(PUBLIC as never);
    primeTransport({ type: 'text/html', body: '<html><head><title>x</title></head></html>' });
    await safeUnfurl('http://github.com/civitai');
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatch(/^https:\/\/github\.com\/civitai/);
  });

  it('applies the same address check to the oEmbed document a page points at', async () => {
    lookupMock.mockImplementation((async (host: string) =>
      host === 'github.com' ? PUBLIC : PRIVATE) as never);
    primeTransport({
      type: 'text/html',
      body: '<html><head><title>x</title><link rel="alternate" type="application/json+oembed" href="https://oembed.example.org/o.json" /></head></html>',
    });
    expect(await errorCode(safeUnfurl('https://github.com/civitai'))).toBe('blocked_host');
    expect(lookupMock).toHaveBeenCalledWith('oembed.example.org', { all: true });
    expect(requested).toHaveLength(1);
  });
});
