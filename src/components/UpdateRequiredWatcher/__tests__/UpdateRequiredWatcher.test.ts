import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted above the imports, so the factory's captures must be too.
const { trigger } = vi.hoisted(() => ({ trigger: vi.fn() }));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger } }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));

import {
  createUpdateAwareFetch,
  isFirstPartyRequest,
} from '~/components/UpdateRequiredWatcher/UpdateRequiredWatcher';

const ORIGIN = 'https://civitai.com';

/** Minimal Response stand-in — the wrapper only ever reads `headers`. */
const responseWith = (headers: Record<string, string>) =>
  ({ headers: new Headers(headers) } as unknown as Response);

beforeEach(() => {
  trigger.mockClear();
});

describe('isFirstPartyRequest', () => {
  it.each([
    ['/api/trpc/orchestrator.generate', true],
    ['api/trpc/thing', true],
    ['https://civitai.com/api/trpc/x', true],
    ['https://civitai.com/_next/static/chunks/main.js', true],
    ['https://securepubads.g.doubleclick.net/gpt/pubads_impl.js', false],
    ['https://www.google-analytics.com/g/collect', false],
    ['http://civitai.com/api/trpc/x', false], // different scheme => different origin
    ['https://sub.civitai.com/api/x', false], // different host => different origin
  ])('classifies %s as first-party=%s', (url, expected) => {
    expect(isFirstPartyRequest(url, ORIGIN)).toBe(expected);
  });

  it('accepts a URL instance', () => {
    expect(isFirstPartyRequest(new URL('https://civitai.com/api/x'), ORIGIN)).toBe(true);
    expect(isFirstPartyRequest(new URL('https://evil.example/x'), ORIGIN)).toBe(false);
  });

  it('accepts a Request-like object with a url property', () => {
    expect(isFirstPartyRequest({ url: 'https://civitai.com/api/x' }, ORIGIN)).toBe(true);
    expect(isFirstPartyRequest({ url: 'https://securepubads.g.doubleclick.net/x' }, ORIGIN)).toBe(
      false
    );
  });

  // FAILS OPEN — an unrecognisable input must never silently disable the update prompt.
  // These inputs yield no usable url string and take the early return.
  it.each([[undefined], [null], [{}], [123], [''], [{ url: 42 }]])(
    'treats the shapeless input %s as first-party',
    (input) => {
      expect(isFirstPartyRequest(input, ORIGIN)).toBe(true);
    }
  );

  // ...and these actually THROW inside the parse, which is the only way to reach the catch.
  // Without them the catch is unreachable and a "fails closed" mutant survives a green suite.
  it.each([['http://'], ['https://'], ['//'], ['http://[']])(
    'treats the unparseable url %s as first-party',
    (input) => {
      expect(isFirstPartyRequest(input, ORIGIN)).toBe(true);
    }
  );

  it('treats a hostile Request-like whose url getter throws as first-party', () => {
    const hostile = {
      get url(): string {
        throw new Error('boom');
      },
    };
    expect(isFirstPartyRequest(hostile, ORIGIN)).toBe(true);
  });

  // A `data:` url has an opaque (null) origin, so it reads as third-party and is passed
  // through — correct, it can never carry our headers. A `blob:` url INHERITS the origin it
  // was minted from, so a same-origin blob stays first-party while a foreign one does not.
  it.each([
    ['data:text/plain,hi', false],
    ['blob:https://civitai.com/abc-123', true],
    ['blob:https://evil.example/x', false],
  ])('classifies the special-scheme url %s as first-party=%s', (input, expected) => {
    expect(isFirstPartyRequest(input, ORIGIN)).toBe(expected);
  });

  // A bare relative-looking oddity still resolves against our origin, so it stays first-party.
  it('treats a resolvable relative oddity as first-party', () => {
    expect(isFirstPartyRequest('::not a url::', ORIGIN)).toBe(true);
  });
});

describe('createUpdateAwareFetch — first-party responses still drive the modal', () => {
  it('triggers the generator-update modal from the generation header, with the notes', async () => {
    const base = vi.fn().mockResolvedValue(
      responseWith({
        'x-generation-update-required': '2.4.0',
        'x-generation-update-notes': 'Sampler list changed',
      })
    );
    const wrapped = createUpdateAwareFetch(base as unknown as typeof fetch, ORIGIN);

    await wrapped('/api/trpc/orchestrator.generate');

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0]).toMatchObject({
      id: 'update-required-modal',
      props: {
        title: 'Generator Update Available',
        description: 'Sampler list changed',
      },
    });
  });

  it('falls back to the default copy when no notes header is present', async () => {
    const base = vi
      .fn()
      .mockResolvedValue(responseWith({ 'x-generation-update-required': '2.4.0' }));
    const wrapped = createUpdateAwareFetch(base as unknown as typeof fetch, ORIGIN);

    await wrapped('/api/trpc/orchestrator.generate');

    expect(trigger.mock.calls[0][0].props.description).toBe(
      'Please refresh to get the latest generator updates.'
    );
  });

  it('triggers the global update modal from the x-update-required header', async () => {
    const base = vi.fn().mockResolvedValue(responseWith({ 'x-update-required': 'true' }));
    const wrapped = createUpdateAwareFetch(base as unknown as typeof fetch, ORIGIN);

    await wrapped('/api/trpc/anything');

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0]).toMatchObject({ id: 'update-required-modal' });
  });

  it('shows the generation modal once per version, and again when the version changes', async () => {
    const base = vi
      .fn()
      .mockResolvedValueOnce(responseWith({ 'x-generation-update-required': '2.4.0' }))
      .mockResolvedValueOnce(responseWith({ 'x-generation-update-required': '2.4.0' }))
      .mockResolvedValueOnce(responseWith({ 'x-generation-update-required': '2.5.0' }));
    const wrapped = createUpdateAwareFetch(base as unknown as typeof fetch, ORIGIN);

    await wrapped('/api/trpc/a');
    await wrapped('/api/trpc/b');
    await wrapped('/api/trpc/c');

    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('shows the global update modal only once', async () => {
    const base = vi.fn().mockResolvedValue(responseWith({ 'x-update-required': 'true' }));
    const wrapped = createUpdateAwareFetch(base as unknown as typeof fetch, ORIGIN);

    await wrapped('/api/trpc/a');
    await wrapped('/api/trpc/b');

    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('returns the original response object unchanged', async () => {
    const response = responseWith({});
    const base = vi.fn().mockResolvedValue(response);
    const wrapped = createUpdateAwareFetch(base as unknown as typeof fetch, ORIGIN);

    await expect(wrapped('/api/trpc/a')).resolves.toBe(response);
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe('createUpdateAwareFetch — third-party requests pass through untouched', () => {
  it('returns the underlying promise identity for a third-party URL', () => {
    const response = responseWith({ 'x-update-required': 'true' });
    const promise = Promise.resolve(response);
    const base = vi.fn().mockReturnValue(promise);
    const wrapped = createUpdateAwareFetch(base as unknown as typeof fetch, ORIGIN);

    // Not merely equivalent — the SAME promise, proving no `.then` link was added.
    expect(wrapped('https://securepubads.g.doubleclick.net/gpt/pubads_impl.js')).toBe(promise);
  });

  it('never inspects headers on a third-party response', async () => {
    const headers = new Headers({ 'x-update-required': 'true' });
    const getSpy = vi.spyOn(headers, 'get');
    const hasSpy = vi.spyOn(headers, 'has');
    const base = vi.fn().mockResolvedValue({ headers } as unknown as Response);
    const wrapped = createUpdateAwareFetch(base as unknown as typeof fetch, ORIGIN);

    await wrapped('https://www.google-analytics.com/g/collect');

    expect(getSpy).not.toHaveBeenCalled();
    expect(hasSpy).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it('forwards every argument to the underlying fetch verbatim', async () => {
    const base = vi.fn().mockResolvedValue(responseWith({}));
    const wrapped = createUpdateAwareFetch(base as unknown as typeof fetch, ORIGIN);
    const init = { method: 'POST', body: 'x' };

    await wrapped('https://securepubads.g.doubleclick.net/x', init);

    expect(base).toHaveBeenCalledWith('https://securepubads.g.doubleclick.net/x', init);
  });

  it('does not swallow a third-party rejection', async () => {
    const boom = new TypeError('Failed to fetch');
    const base = vi.fn().mockRejectedValue(boom);
    const wrapped = createUpdateAwareFetch(base as unknown as typeof fetch, ORIGIN);

    await expect(wrapped('https://securepubads.g.doubleclick.net/x')).rejects.toBe(boom);
  });
});

describe('createUpdateAwareFetch — argument fidelity and header interaction', () => {
  // The third-party arm of this is covered above, but that path is a bare `return baseFetch(...)`.
  // The FIRST-party path rebuilds the call, so dropping `init` there would strip the method, body
  // and headers from every tRPC request while every other test stayed green.
  it('forwards init verbatim on the FIRST-party path too', async () => {
    const base = vi.fn().mockResolvedValue(responseWith({}));
    const wrapped = createUpdateAwareFetch(base as unknown as typeof fetch, ORIGIN);
    const init = {
      method: 'POST',
      body: '{"json":1}',
      headers: { 'content-type': 'application/json' },
    };

    await wrapped('/api/trpc/orchestrator.generate', init);

    expect(base).toHaveBeenCalledWith('/api/trpc/orchestrator.generate', init);
  });

  // The generation-specific modal suppresses the global one. Without a response carrying BOTH
  // headers, deleting `&& !generationWarnedVersion` changes nothing any test can see.
  it('shows only ONE modal when a response carries both update headers', async () => {
    const base = vi
      .fn()
      .mockResolvedValue(
        responseWith({ 'x-generation-update-required': '2.4.0', 'x-update-required': 'true' })
      );
    const wrapped = createUpdateAwareFetch(base as unknown as typeof fetch, ORIGIN);

    await wrapped('/api/trpc/a');

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0].props.title).toBe('Generator Update Available');
  });
});

describe('installUpdateAwareFetch — the install seam', () => {
  /** A window stub whose `origin` and `href` DIFFER, so using the wrong one is detectable. */
  const makeWin = () => {
    const base = vi.fn().mockResolvedValue(responseWith({ 'x-update-required': 'true' }));
    return {
      fetch: base as unknown as typeof fetch,
      location: { origin: ORIGIN, href: `${ORIGIN}/models/123` } as Location,
      base,
    };
  };

  const freshModule = async () => {
    vi.resetModules();
    return import('~/components/UpdateRequiredWatcher/UpdateRequiredWatcher');
  };

  it('replaces win.fetch', async () => {
    const mod = await freshModule();
    const win = makeWin();
    const before = win.fetch;
    mod.installUpdateAwareFetch(win);
    expect(win.fetch).not.toBe(before);
  });

  // Uses an ABSOLUTE same-origin url on purpose: a root-relative path short-circuits before the
  // origin comparison, so it could not tell `location.origin` from `location.href`.
  it('passes location.ORIGIN, not location.href', async () => {
    const mod = await freshModule();
    const win = makeWin();
    mod.installUpdateAwareFetch(win);

    await win.fetch(`${ORIGIN}/api/trpc/x`);

    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a second install does not stack another wrapper', async () => {
    const mod = await freshModule();
    const win = makeWin();
    mod.installUpdateAwareFetch(win);
    const afterFirst = win.fetch;
    mod.installUpdateAwareFetch(win);
    expect(win.fetch).toBe(afterFirst);

    await win.fetch(`${ORIGIN}/api/trpc/x`);
    expect(win.base).toHaveBeenCalledTimes(1);
  });
});
