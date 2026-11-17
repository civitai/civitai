import { describe, expect, it, vi } from 'vitest';
import { APP_SURFACE_PARAM } from '~/shared/utils/app-store-telemetry';
import { APPS_RUN_FROM_PARAM, HOST_OWNED_RUN_PARAMS } from '~/shared/utils/apps-run-origin';
import { BLOCK_HOST_SHARE_LINK } from '../blockInitFragmentGate';
import {
  SHARE_LINK_MAX_FIELD_LENGTH,
  createShareLinkLimiter,
  navigateWantsReplace,
  performShareLink,
  resolveBridgeLocation,
  resolveShareLinkRequest,
  SHARE_LINK_INVALID_ERROR,
  SHARE_LINK_MIN_INTERVAL_MS,
  SHARE_LINK_NOT_READY_ERROR,
  SHARE_LINK_UNAVAILABLE_ERROR,
} from '../deepLinkLogic';

/**
 * Deep links into app state — the pure half.
 *
 *  - `resolveBridgeLocation`: the search and hash the host forwards to the block in
 *    BLOCK_INIT.context and ROUTE_CHANGED, read from the host URL (`router.asPath`).
 *  - `resolveShareLinkRequest`: the canonical absolute URL a SHARE_LINK builds. The URL
 *    is built from the HOST's origin, deep-link base and slug only; the app supplies
 *    subPath / search / hash, and nothing it sends may leave `/apps/run/<slug>`.
 *  - `performShareLink`: the copy / share itself, and its honest result.
 *  - `createShareLinkLimiter`: one in flight, at most one per interval.
 */

const ORIGIN = 'https://civitai.com';
const SLUG = 'live-characters';
const PREFIX = `${ORIGIN}/apps/run/${SLUG}`;
const OK_OPTS = {
  base: '/apps/run',
  slug: SLUG,
  origin: ORIGIN,
  ready: true,
  reviewMode: false,
  shareable: true,
};

describe('resolveBridgeLocation — search and hash forwarded to the block', () => {
  it('reads the search and hash off the host path', () => {
    expect(resolveBridgeLocation(`/apps/run/${SLUG}/c/42?take=3#top`)).toEqual({
      search: '?take=3',
      hash: '#top',
    });
  });

  it('is empty on a bare app route', () => {
    expect(resolveBridgeLocation(`/apps/run/${SLUG}`)).toEqual({ search: '', hash: '' });
    expect(resolveBridgeLocation(`/apps/run/${SLUG}/c/42`)).toEqual({ search: '', hash: '' });
  });

  it('strips the host-owned launch-origin `from` pair, however it is spelled', () => {
    expect(resolveBridgeLocation(`/apps/run/${SLUG}?from=home`)).toEqual({ search: '', hash: '' });
    expect(resolveBridgeLocation(`/apps/run/${SLUG}?from=home&take=3`).search).toBe('?take=3');
    expect(resolveBridgeLocation(`/apps/run/${SLUG}?take=3&from=home`).search).toBe('?take=3');
    expect(resolveBridgeLocation(`/apps/run/${SLUG}?fr%6Fm=home&take=3`).search).toBe('?take=3');
  });

  it('🔴 strips EVERY host-owned attribution pair — `sl` and `src` as well as `from`', () => {
    expect(
      resolveBridgeLocation(
        `/apps/run/${SLUG}/c/42?sl=asl_01J0000000000000000000000A&take=3&src=store_card&from=home#top`
      )
    ).toEqual({ search: '?take=3', hash: '#top' });
    expect(resolveBridgeLocation(`/apps/run/${SLUG}?%73l=x&s%72c=detail`)).toEqual({
      search: '',
      hash: '',
    });
  });

  it('the host-owned list names the exported host params (one list, not three spellings)', () => {
    expect(HOST_OWNED_RUN_PARAMS).toContain(APPS_RUN_FROM_PARAM);
    expect(HOST_OWNED_RUN_PARAMS).toContain(APP_SURFACE_PARAM);
  });

  it('keeps the remaining pairs byte-for-byte, in order', () => {
    expect(resolveBridgeLocation(`/apps/run/${SLUG}?q=a%20b+c&z=1&a=2`).search).toBe(
      '?q=a%20b+c&z=1&a=2'
    );
  });

  it('forwards a long search and hash INTACT — the host does not cap its own URL', () => {
    // Overshoots the share-side cap, so a re-introduced inbound cap at that constant fails here.
    const long = 'x'.repeat(SHARE_LINK_MAX_FIELD_LENGTH + 500);
    expect(resolveBridgeLocation(`/apps/run/${SLUG}?q=${long}#${long}`)).toEqual({
      search: `?q=${long}`,
      hash: `#${long}`,
    });
  });

  it('never forwards a control character', () => {
    const { search, hash } = resolveBridgeLocation(`/apps/run/${SLUG}?a=\u0001b#c\u0002d`);
    expect(search).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(hash).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('cannot change the path: a search or hash that LOOKS like a path stays a search or hash', () => {
    const { search, hash } = resolveBridgeLocation(
      `/apps/run/${SLUG}?next=/apps/run/other#/../../x`
    );
    expect(search).toBe('?next=/apps/run/other');
    expect(hash).toBe('#/../../x');
  });
});

describe('resolveShareLinkRequest — the canonical share URL', () => {
  it('builds the absolute run URL from the host origin, base and slug', () => {
    expect(
      resolveShareLinkRequest(
        { requestId: 'r1', subPath: 'c/42', search: '?take=3', hash: '#top' },
        OK_OPTS
      )
    ).toEqual({ kind: 'ok', requestId: 'r1', url: `${PREFIX}/c/42?take=3#top` });
  });

  it('the app root is the bare run URL', () => {
    expect(resolveShareLinkRequest({ requestId: 'r1', subPath: '' }, OK_OPTS)).toEqual({
      kind: 'ok',
      requestId: 'r1',
      url: PREFIX,
    });
    expect(resolveShareLinkRequest({ requestId: 'r1' }, OK_OPTS)).toEqual({
      kind: 'ok',
      requestId: 'r1',
      url: PREFIX,
    });
  });

  it('a leading slash on subPath means nothing (same as NAVIGATE)', () => {
    expect(resolveShareLinkRequest({ requestId: 'r1', subPath: '/c/42' }, OK_OPTS)).toEqual({
      kind: 'ok',
      requestId: 'r1',
      url: `${PREFIX}/c/42`,
    });
  });

  it('🔴 never carries a host-owned pair: `sl` and `src` are stripped as well as `from`', () => {
    expect(
      resolveShareLinkRequest(
        { requestId: 'r1', subPath: 'c/42', search: '?sl=asl_x&take=3&src=detail&fr%6Fm=home' },
        OK_OPTS
      )
    ).toEqual({ kind: 'ok', requestId: 'r1', url: `${PREFIX}/c/42?take=3` });
  });

  it('never carries the host-owned `from` pair', () => {
    expect(
      resolveShareLinkRequest(
        { requestId: 'r1', subPath: 'c/42', search: '?from=home&take=3' },
        OK_OPTS
      )
    ).toEqual({ kind: 'ok', requestId: 'r1', url: `${PREFIX}/c/42?take=3` });
  });

  it.each([
    ['..', { subPath: '..' }],
    ['../other-app', { subPath: '../other-app' }],
    ['c/../../other-app', { subPath: 'c/../../other-app' }],
    ['%2e%2e/other-app', { subPath: '%2e%2e/other-app' }],
    ['//evil.com', { subPath: '//evil.com' }],
    ['/\\evil.com', { subPath: '/\\evil.com' }],
    ['javascript:', { subPath: 'javascript:alert(1)' }],
    ['https://evil.com', { subPath: 'https://evil.com/x' }],
    ['a %2f separator', { subPath: 'a%2fb' }],
    ['a query inside subPath', { subPath: 'c/42?take=3' }],
    ['a fragment inside subPath', { subPath: 'c/42#top' }],
    ['a search without its ?', { subPath: 'c', search: 'take=3' }],
    ['a search carrying a fragment', { subPath: 'c', search: '?take=3#x' }],
    ['a search that is a URL', { subPath: 'c', search: '//evil.com' }],
    ['a hash without its #', { subPath: 'c', hash: 'javascript:alert(1)' }],
    ['a control character', { subPath: 'c\u0000' }],
    ['a non-string subPath', { subPath: 42 }],
    ['a non-string search', { search: ['?a=1'] }],
    ['an over-long subPath', { subPath: 'a/'.repeat(SHARE_LINK_MAX_FIELD_LENGTH) }],
    ['an over-long search', { search: `?q=${'x'.repeat(SHARE_LINK_MAX_FIELD_LENGTH)}` }],
    ['an over-long hash', { hash: `#${'x'.repeat(SHARE_LINK_MAX_FIELD_LENGTH)}` }],
  ])('refuses %s', (_label, fields) => {
    expect(resolveShareLinkRequest({ requestId: 'r1', ...fields }, OK_OPTS)).toEqual({
      kind: 'refuse',
      requestId: 'r1',
      error: SHARE_LINK_INVALID_ERROR,
    });
  });

  it('every URL it does build stays under /apps/run/<slug> on the host origin (corpus)', () => {
    const corpus = [
      '',
      'c',
      'c/42',
      '/c/42',
      'c/42/',
      'José',
      'a b',
      'x/50%-off',
      '...',
      '..b',
      'b..',
      '%252e%252e/x',
      'api/auth/logout',
      'c/%2e',
      'c/.',
      'c/./d',
      '.',
      './x',
    ];
    const hashes = ['', '#', '#top', '#/../../x', '#javascript:alert(1)', '#//evil.com'];
    const searches = ['', '?', '?take=3', '?next=//evil.com', '?a=..%2f..'];
    let built = 0;
    for (const subPath of corpus) {
      for (const search of searches) {
        for (const hash of hashes) {
          const r = resolveShareLinkRequest({ requestId: 'r', subPath, search, hash }, OK_OPTS);
          if (r.kind !== 'ok') continue;
          built++;
          const u = new URL(r.url);
          expect(u.origin).toBe(ORIGIN);
          expect(
            u.pathname === `/apps/run/${SLUG}` || u.pathname.startsWith(`/apps/run/${SLUG}/`)
          ).toBe(true);
        }
      }
    }
    // Positive control: the corpus is not refused wholesale.
    expect(built).toBeGreaterThan(100);
  });

  it('encodes the host slug; the app cannot pick a different one', () => {
    expect(
      resolveShareLinkRequest({ requestId: 'r1', subPath: 'c' }, { ...OK_OPTS, slug: 'odd slug' })
    ).toEqual({ kind: 'ok', requestId: 'r1', url: `${ORIGIN}/apps/run/odd%20slug/c` });
  });

  it('refuses where the surface has no app route, and in review', () => {
    expect(
      resolveShareLinkRequest({ requestId: 'r1', subPath: 'c' }, { ...OK_OPTS, base: null })
    ).toEqual({
      kind: 'refuse',
      requestId: 'r1',
      error: SHARE_LINK_UNAVAILABLE_ERROR,
    });
    expect(
      resolveShareLinkRequest({ requestId: 'r1', subPath: 'c' }, { ...OK_OPTS, reviewMode: true })
    ).toEqual({ kind: 'refuse', requestId: 'r1', error: SHARE_LINK_UNAVAILABLE_ERROR });
  });

  it('refuses where the surface may not share — the dev tunnel, whose slug is a block id', () => {
    expect(BLOCK_HOST_SHARE_LINK['dev-tunnel']).toBe(false);
    expect(
      resolveShareLinkRequest({ requestId: 'r1', subPath: 'c' }, { ...OK_OPTS, shareable: false })
    ).toEqual({ kind: 'refuse', requestId: 'r1', error: SHARE_LINK_UNAVAILABLE_ERROR });
  });

  it('refuses before the handshake', () => {
    expect(
      resolveShareLinkRequest({ requestId: 'r1', subPath: 'c' }, { ...OK_OPTS, ready: false })
    ).toEqual({
      kind: 'refuse',
      requestId: 'r1',
      error: SHARE_LINK_NOT_READY_ERROR,
    });
  });

  it('drops a payload with no usable requestId (nothing to reply to)', () => {
    expect(resolveShareLinkRequest({ subPath: 'c' }, OK_OPTS)).toEqual({ kind: 'drop' });
    expect(resolveShareLinkRequest({ requestId: '', subPath: 'c' }, OK_OPTS)).toEqual({
      kind: 'drop',
    });
    expect(resolveShareLinkRequest(null, OK_OPTS)).toEqual({ kind: 'drop' });
    expect(resolveShareLinkRequest('r1', OK_OPTS)).toEqual({ kind: 'drop' });
  });

  it('pins the error strings the SDK documents', () => {
    expect(SHARE_LINK_INVALID_ERROR).toBe('invalid share link');
    expect(SHARE_LINK_UNAVAILABLE_ERROR).toBe('sharing is not available here');
    expect(SHARE_LINK_NOT_READY_ERROR).toBe('the app is not ready yet');
  });
});

describe('performShareLink — the copy or share, and an honest result', () => {
  const URL_ = `${PREFIX}/c/42`;

  it('clipboard write resolves → copied:true, method clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    await expect(
      performShareLink(URL_, {
        userActivation: true,
        frameHasFocus: true,
        coarsePointer: false,
        clipboardWriteText: writeText,
      })
    ).resolves.toEqual({ url: URL_, copied: true, method: 'clipboard' });
    expect(writeText).toHaveBeenCalledWith(URL_);
  });

  it('🔴 clipboard write REJECTS → copied:false, method none (never copied:true)', async () => {
    const writeText = vi
      .fn()
      .mockRejectedValue(new DOMException('Document is not focused.', 'NotAllowedError'));
    await expect(
      performShareLink(URL_, {
        userActivation: true,
        frameHasFocus: true,
        coarsePointer: false,
        clipboardWriteText: writeText,
      })
    ).resolves.toEqual({ url: URL_, copied: false, method: 'none' });
  });

  it('a clipboard write that THROWS synchronously is also copied:false', async () => {
    const writeText = vi.fn(() => {
      throw new Error('boom');
    });
    await expect(
      performShareLink(URL_, {
        userActivation: true,
        frameHasFocus: true,
        coarsePointer: false,
        clipboardWriteText: writeText,
      })
    ).resolves.toEqual({ url: URL_, copied: false, method: 'none' });
  });

  it('no clipboard API → method none', async () => {
    await expect(
      performShareLink(URL_, { userActivation: true, frameHasFocus: true, coarsePointer: false })
    ).resolves.toEqual({
      url: URL_,
      copied: false,
      method: 'none',
    });
  });

  it('🔴 the write is issued SYNCHRONOUSLY — before the call returns, nothing awaited first', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    void performShareLink(URL_, {
      userActivation: true,
      frameHasFocus: true,
      coarsePointer: false,
      clipboardWriteText: writeText,
    });
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('without user activation neither the clipboard nor the share sheet is touched', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const share = vi.fn().mockResolvedValue(undefined);
    await expect(
      performShareLink(URL_, {
        userActivation: false,
        frameHasFocus: true,
        coarsePointer: true,
        clipboardWriteText: writeText,
        share,
      })
    ).resolves.toEqual({ url: URL_, copied: false, method: 'none' });
    expect(writeText).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });

  it('🔴 activation WITHOUT focus on the frame (a click on host chrome) touches neither API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const share = vi.fn().mockResolvedValue(undefined);
    await expect(
      performShareLink(URL_, {
        userActivation: true,
        frameHasFocus: false,
        coarsePointer: true,
        clipboardWriteText: writeText,
        share,
      })
    ).resolves.toEqual({ url: URL_, copied: false, method: 'none' });
    await expect(
      performShareLink(URL_, {
        userActivation: true,
        frameHasFocus: false,
        coarsePointer: false,
        clipboardWriteText: writeText,
      })
    ).resolves.toEqual({ url: URL_, copied: false, method: 'none' });
    expect(writeText).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });

  it('activation UNKNOWN (no userActivation API) still attempts the write; the browser decides', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    await expect(
      performShareLink(URL_, {
        userActivation: null,
        frameHasFocus: true,
        coarsePointer: false,
        clipboardWriteText: writeText,
      })
    ).resolves.toEqual({ url: URL_, copied: true, method: 'clipboard' });
  });

  it('phones (coarse pointer + share) open the share sheet instead of the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const share = vi.fn().mockResolvedValue(undefined);
    await expect(
      performShareLink(URL_, {
        userActivation: true,
        frameHasFocus: true,
        coarsePointer: true,
        clipboardWriteText: writeText,
        share,
      })
    ).resolves.toEqual({ url: URL_, copied: false, method: 'share' });
    expect(share).toHaveBeenCalledWith({ url: URL_ });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('a cancelled or refused share sheet is method none', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'));
    await expect(
      performShareLink(URL_, {
        userActivation: true,
        frameHasFocus: true,
        coarsePointer: true,
        share,
      })
    ).resolves.toEqual({ url: URL_, copied: false, method: 'none' });
  });

  it('canShare(false) falls back to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const share = vi.fn().mockResolvedValue(undefined);
    await expect(
      performShareLink(URL_, {
        userActivation: true,
        frameHasFocus: true,
        coarsePointer: true,
        clipboardWriteText: writeText,
        share,
        canShare: () => false,
      })
    ).resolves.toEqual({ url: URL_, copied: true, method: 'clipboard' });
    expect(share).not.toHaveBeenCalled();
  });

  it('a throwing canShare resolves to method none instead of throwing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const share = vi.fn().mockResolvedValue(undefined);
    let result: Promise<unknown> | undefined;
    expect(() => {
      result = performShareLink(URL_, {
        userActivation: true,
        frameHasFocus: true,
        coarsePointer: true,
        clipboardWriteText: writeText,
        share,
        canShare: () => {
          throw new TypeError('bad share data');
        },
      });
    }).not.toThrow();
    await expect(result).resolves.toEqual({ url: URL_, copied: false, method: 'none' });
    expect(share).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('desktop (fine pointer) uses the clipboard even when share exists', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const share = vi.fn().mockResolvedValue(undefined);
    await expect(
      performShareLink(URL_, {
        userActivation: true,
        frameHasFocus: true,
        coarsePointer: false,
        clipboardWriteText: writeText,
        share,
      })
    ).resolves.toEqual({ url: URL_, copied: true, method: 'clipboard' });
    expect(share).not.toHaveBeenCalled();
  });
});

describe('createShareLinkLimiter — an app cannot spam the share sheet', () => {
  it('admits one, refuses while it is in flight, then holds the interval', () => {
    let t = 10_000;
    const limiter = createShareLinkLimiter(() => t);
    expect(limiter.admit()).toBe(true);
    expect(limiter.admit()).toBe(false); // in flight
    limiter.settle();
    t += SHARE_LINK_MIN_INTERVAL_MS - 1;
    expect(limiter.admit()).toBe(false); // inside the interval
    t += 1;
    expect(limiter.admit()).toBe(true);
    limiter.settle();
  });

  it('an in-flight share blocks the next one even past the interval', () => {
    let t = 0;
    const limiter = createShareLinkLimiter(() => t);
    expect(limiter.admit()).toBe(true);
    t += 5 * SHARE_LINK_MIN_INTERVAL_MS;
    expect(limiter.admit()).toBe(false);
    limiter.settle();
    expect(limiter.admit()).toBe(true);
  });
});

describe('navigateWantsReplace', () => {
  it('only the literal true asks for replace', () => {
    expect(navigateWantsReplace({ path: 'c', replace: true })).toBe(true);
    expect(navigateWantsReplace({ path: 'c', replace: 'true' })).toBe(false);
    expect(navigateWantsReplace({ path: 'c', replace: 1 })).toBe(false);
    expect(navigateWantsReplace({ path: 'c' })).toBe(false);
    expect(navigateWantsReplace(null)).toBe(false);
  });
});
