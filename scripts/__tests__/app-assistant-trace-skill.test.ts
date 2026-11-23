import { describe, expect, it } from 'vitest';
import {
  EXIT,
  loadConfig,
  parseCommand,
  requestUrl,
  run,
  UsageError,
} from '../../.claude/skills/app-assistant-trace/lib.mjs';

/**
 * The app-assistant-trace skill's CLI (`.claude/skills/app-assistant-trace`): argument parsing, the
 * URL each command reads, and what it prints and exits with, against a stubbed fetch. Lives here so
 * the CI unit job runs it, as the dev-server skill's tests do.
 */

// TEST-ONLY placeholder key: never a real credential.
const KEY = 'test-only-trace-key-7731';
const API = 'https://api.example';
const R = `${API}/api/mod/apps/assistant-trace`;

type Init = { method: string; headers: Record<string, string> };

function capture() {
  const out = { stdout: '', stderr: '' };
  return {
    out,
    stdout: { write: (s: string) => void (out.stdout += s) },
    stderr: { write: (s: string) => void (out.stderr += s) },
  };
}

function stubFetch(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: Init }[] = [];
  const fetch = async (url: string, init: Init) => {
    calls.push({ url, init });
    return answer();
  };
  return { calls, fetch };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function usageError(argv: string[]): Error | undefined {
  try {
    parseCommand(argv);
  } catch (e) {
    if (e instanceof UsageError) return e;
    throw e;
  }
  return undefined;
}

describe('app-assistant-trace CLI: arguments and URLs', () => {
  it.each<[string[], string]>([
    [['request', 'pubreq_abc'], `${R}/request?publishRequestId=pubreq_abc`],
    [
      ['app', 'my-app', '--limit', '7', '--cursor', 'pubreq_z'],
      `${R}/app?limit=7&cursor=pubreq_z&slug=my-app`,
    ],
    [['app', 'my-app'], `${R}/app?slug=my-app`],
    [
      ['transcript', 'pubreq_abc', 'conv 1/x', '--tool-output-chars=300'],
      `${R}/transcript?toolOutputChars=300&publishRequestId=pubreq_abc&conversationId=conv+1%2Fx`,
    ],
    [
      ['signals', '--from', '2026-09-01', '--to', '2026-12-01'],
      `${R}/signals?from=2026-09-01&to=2026-12-01`,
    ],
    [['signals'], `${R}/signals`],
  ])('%j reads %s', (argv, url) => {
    expect(requestUrl(API, parseCommand(argv))).toBe(url);
  });

  it.each<[string[], RegExp]>([
    [['nope'], /Unknown command: nope/],
    [['request'], /request takes <publishRequestId>/],
    [['request', 'a', 'b'], /request takes <publishRequestId>/],
    [['transcript', 'pubreq_abc'], /transcript takes <publishRequestId> <conversationId>/],
    [['signals', 'extra'], /signals takes no arguments/],
    [['app', 'x', '--limit'], /--limit needs a value/],
    [['app', 'x', '--limit', '--cursor', 'y'], /--limit needs a value/],
    [['app', 'x', '--limit', 'ten'], /--limit must be a whole number/],
    [['app', 'x', '--from', '2026-01-01'], /Unknown option for app: --from/],
    [['signals', '--from', 'yesterday'], /--from must be a date/],
    [['transcript', 'p', 'c', '--tool-output-chars', '-1'], /--tool-output-chars/],
  ])('%j is a usage error matching %s', (argv, message) => {
    expect(usageError(argv)?.message).toMatch(message);
  });

  it('the process env wins over the skill .env; the URL loses its trailing slash; production is the default', () => {
    expect(
      loadConfig(
        { CIVITAI_API_KEY: 'env-key' },
        { CIVITAI_API_KEY: 'file-key', CIVITAI_API_URL: 'http://localhost:3000/' }
      )
    ).toEqual({ apiKey: 'env-key', apiUrl: 'http://localhost:3000' });
    expect(loadConfig({}, {})).toEqual({ apiKey: '', apiUrl: 'https://civitai.com' });
  });
});

describe('app-assistant-trace CLI: calls', () => {
  const env = { CIVITAI_API_KEY: KEY, CIVITAI_API_URL: API };

  it('sends the key as a bearer GET and prints the API’s JSON', async () => {
    const { calls, fetch } = stubFetch(() => json({ request: { id: 'pubreq_abc' }, trace: null }));
    const io = capture();
    expect(await run(['request', 'pubreq_abc'], { fetch, env, file: {}, ...io })).toBe(EXIT.ok);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${R}/request?publishRequestId=pubreq_abc`);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(io.out.stdout)).toEqual({ request: { id: 'pubreq_abc' }, trace: null });
  });

  it('an API refusal exits non-zero with the API’s status and code, and never prints the key', async () => {
    const { fetch } = stubFetch(() =>
      json({ error: 'That chat is not part of the request’s trace', code: 'NOT_FOUND' }, 404)
    );
    const io = capture();
    expect(await run(['transcript', 'pubreq_abc', 'conv-1'], { fetch, env, file: {}, ...io })).toBe(
      EXIT.api
    );
    expect(JSON.parse(io.out.stderr)).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      error: 'That chat is not part of the request’s trace',
    });
    expect(io.out.stdout).toBe('');
    expect(io.out.stderr).not.toContain(KEY);
  });

  it('a front-door refusal with no code, and a network failure, both exit non-zero', async () => {
    const refused = capture();
    const { fetch } = stubFetch(() => json({ error: 'Moderator role required' }, 403));
    expect(await run(['signals'], { fetch, env, file: {}, ...refused })).toBe(EXIT.api);
    expect(JSON.parse(refused.out.stderr)).toEqual({
      status: 403,
      code: null,
      error: 'Moderator role required',
    });

    const down = capture();
    const failing = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await run(['signals'], { fetch: failing, env, file: {}, ...down })).toBe(EXIT.api);
    expect(JSON.parse(down.out.stderr)).toMatchObject({ status: null, code: 'NETWORK' });
    expect(down.out.stderr).not.toContain(KEY);
  });

  it('no key, or a bad command line, exits 2 and calls nothing', async () => {
    const { calls, fetch } = stubFetch(() => json({}));
    const noKey = capture();
    expect(await run(['signals'], { fetch, env: {}, file: {}, ...noKey })).toBe(EXIT.usage);
    expect(noKey.out.stderr).toMatch(/CIVITAI_API_KEY is not set/);
    const usage = capture();
    expect(await run(['app'], { fetch, env, file: {}, ...usage })).toBe(EXIT.usage);
    expect(usage.out.stderr).toMatch(/app takes <slug>/);
    expect(calls).toHaveLength(0);
  });
});
