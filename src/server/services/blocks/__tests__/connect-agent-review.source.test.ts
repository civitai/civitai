import { describe, expect, it, vi } from 'vitest';
import {
  commitShaFromArchiveUrl,
  connectListingFingerprint,
  connectSourceArchiveUrl,
  type ConnectReviewSubject,
} from '~/server/services/blocks/connect-agent-review.logic';
import {
  civitaiCheckLines,
  offlineAccessDeclaration,
} from '~/shared/constants/connect-agent-review.constants';
import { fetchConnectSource } from '~/server/services/blocks/connect-agent-review.service';

/**
 * Agent review, connect lane: the linked public server source. Which URL is fetched, which hosts
 * a redirect may reach, and what the report says when the source cannot be reviewed. The
 * fetcher is injected (the real one is `safeFetch`), so nothing here touches the network.
 */

const SHA40 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('connectSourceArchiveUrl', () => {
  it('github: archive/HEAD.zip, redirects held to github.com + codeload.github.com', () => {
    expect(connectSourceArchiveUrl('https://github.com/ann/photo-sync')).toEqual({
      url: 'https://github.com/ann/photo-sync/archive/HEAD.zip',
      hosts: ['github.com', 'codeload.github.com'],
    });
  });

  it('gitlab: the -/archive/HEAD form', () => {
    expect(connectSourceArchiveUrl('https://gitlab.com/ann/photo-sync')).toEqual({
      url: 'https://gitlab.com/ann/photo-sync/-/archive/HEAD/photo-sync-HEAD.zip',
      hosts: ['gitlab.com'],
    });
  });

  it.each([
    ['codeberg (not fetched)', 'https://codeberg.org/ann/photo-sync'],
    ['an unlisted host', 'https://evil.example/ann/photo-sync'],
    ['plain http', 'http://github.com/ann/photo-sync'],
    ['a deeper path', 'https://github.com/ann/photo-sync/tree/main'],
    ['not a URL', 'github.com/ann/photo-sync'],
  ])('%s → null', (_label, url) => {
    expect(connectSourceArchiveUrl(url)).toBeNull();
  });
});

describe('commitShaFromArchiveUrl', () => {
  it('reads the commit from the codeload redirect target', () => {
    expect(commitShaFromArchiveUrl(`https://codeload.github.com/ann/photo-sync/zip/${SHA40}`)).toBe(
      SHA40
    );
  });
  it('a branch-named target is not a commit', () => {
    expect(
      commitShaFromArchiveUrl('https://codeload.github.com/ann/photo-sync/zip/refs/heads/main')
    ).toBeNull();
  });
});

describe('fetchConnectSource', () => {
  it('no link → not provided, and nothing is fetched', async () => {
    const fetcher = vi.fn();
    await expect(fetchConnectSource(null, fetcher)).resolves.toEqual({
      result: { provided: false },
      archive: null,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('github: fetches through the guarded fetcher with its host allowlist, records the commit and hash', async () => {
    const bytes = Buffer.from('PK-archive-bytes');
    const fetcher = vi.fn(async () => ({
      finalUrl: `https://codeload.github.com/ann/photo-sync/zip/${SHA40}`,
      bytes,
    }));
    const { result, archive } = await fetchConnectSource(
      'https://github.com/ann/photo-sync',
      fetcher
    );
    expect(archive).toBe(bytes);
    expect(result).toEqual({
      provided: true,
      repoUrl: 'https://github.com/ann/photo-sync',
      fetched: true,
      // sha256('PK-archive-bytes')
      archiveSha256: '626fc286e06a703f38141aa258dfbc0610da6c63d0e41fcc278ea113dcd85d75',
      commitSha: SHA40,
      bytes: 16,
    });
    const [url, opts] = fetcher.mock.calls[0] as unknown as [
      string,
      {
        allowUrl: (u: URL) => boolean;
        maxBytes: number;
        maxRedirects: number;
        deadlineMs: number;
        timeoutMs: number;
      }
    ];
    expect(url).toBe('https://github.com/ann/photo-sync/archive/HEAD.zip');
    expect(opts.maxBytes).toBe(25 * 1024 * 1024);
    expect(opts.maxRedirects).toBe(2);
    // F4: ONE 30 s deadline for the whole chain, not 30 s per hop.
    expect(opts.deadlineMs).toBe(30_000);
    expect(opts.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(opts.allowUrl(new URL('https://codeload.github.com/x/y/zip/z'))).toBe(true);
    // A redirect off the forge is refused before any socket opens.
    expect(opts.allowUrl(new URL('https://metadata.internal/latest'))).toBe(false);
  });

  it.each([
    ['too_large', 'the archive is larger than 25 MB'],
    ['bad_status', 'the host did not return an archive (is the repository public?)'],
    ['timeout', 'the download timed out'],
    ['blocked_host', 'the download failed'],
  ])('a %s failure is "linked, not fetched" with a plain reason', async (code, reason) => {
    const fetcher = vi.fn(async () => {
      throw Object.assign(new Error('x'), { code });
    });
    await expect(fetchConnectSource('https://gitlab.com/ann/photo-sync', fetcher)).resolves.toEqual(
      {
        result: {
          provided: true,
          repoUrl: 'https://gitlab.com/ann/photo-sync',
          fetched: false,
          reason,
        },
        archive: null,
      }
    );
  });

  it('a host it does not fetch from is reported, not attempted', async () => {
    const fetcher = vi.fn();
    const { result } = await fetchConnectSource('https://codeberg.org/ann/photo-sync', fetcher);
    expect(result).toEqual({
      provided: true,
      repoUrl: 'https://codeberg.org/ann/photo-sync',
      fetched: false,
      reason: 'source from this host is not fetched automatically',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('connectListingFingerprint (F3)', () => {
  const base: ConnectReviewSubject = {
    publishRequestId: 'alpr_X',
    slug: 's',
    changelog: 'not reviewed for staleness',
    listing: {
      id: 'apl_L',
      name: 'Photo Sync',
      tagline: 'tag',
      description: 'desc',
      category: 'tools',
      externalUrl: null,
      sourceRepoUrl: 'https://github.com/ann/photo-sync',
      contentRating: 'g',
      requestedScopes: 36,
      scopeJustifications: { MediaRead: 'copy', ModelsRead: 'browse' },
    },
    client: {
      id: 'oc',
      name: 'c',
      description: '',
      redirectUris: ['https://a.example/cb', 'https://b.example/cb'],
      allowedOrigins: [],
      grants: ['authorization_code', 'refresh_token'],
      isConfidential: true,
      isVerified: false,
    },
  };
  const fp = (over: (s: ConnectReviewSubject) => void) => {
    const s = structuredClone(base);
    over(s);
    return connectListingFingerprint(s);
  };

  it.each([
    ['scopes', (s: ConnectReviewSubject) => void (s.listing.requestedScopes = 37)],
    [
      'a justification',
      (s: ConnectReviewSubject) => void (s.listing.scopeJustifications!.MediaRead = 'x'),
    ],
    ['the description', (s: ConnectReviewSubject) => void (s.listing.description = 'desc!')],
    ['a link', (s: ConnectReviewSubject) => void (s.listing.sourceRepoUrl = null)],
    [
      'a redirect URI',
      (s: ConnectReviewSubject) => void s.client.redirectUris.push('https://c.example'),
    ],
    ['the grants', (s: ConnectReviewSubject) => void s.client.grants.pop()],
  ])('changes when %s changes', (_label, mutate) => {
    expect(fp(mutate)).not.toBe(connectListingFingerprint(base));
  });

  it('ignores order of justification keys and redirect URIs, and fields the review did not read', () => {
    expect(
      fp((s) => {
        s.listing.scopeJustifications = { ModelsRead: 'browse', MediaRead: 'copy' };
        s.client.redirectUris.reverse();
        s.changelog = 'edited';
      })
    ).toBe(connectListingFingerprint(base));
  });
});

describe('civitaiCheckLines', () => {
  it('a fetched source names the repo and commit, and says it is not proof of what runs', () => {
    expect(
      civitaiCheckLines({
        offlineAccess: { reachable: false, alwaysOffline: false, grants: [] },
        source: {
          provided: true,
          repoUrl: 'https://github.com/ann/photo-sync',
          fetched: true,
          archiveSha256: 'f'.repeat(64),
          commitSha: SHA40,
          bytes: 9,
        },
      })
    ).toEqual([
      {
        tone: 'info',
        text: 'Offline access: not reachable. The OAuth client holds no refresh-token or device grant.',
      },
      {
        tone: 'info',
        text:
          `Server source reviewed from https://github.com/ann/photo-sync at commit ${SHA40}. ` +
          'It is the code the author links, not proof of what runs on their server.',
      },
    ]);
  });
});

describe('civitaiCheckLines — offline-access declaration vs what the client can do', () => {
  const lines = (reachable: boolean, declared: boolean | undefined, alwaysOffline = false) =>
    civitaiCheckLines({
      offlineAccess: { reachable, alwaysOffline, grants: [], declared },
      source: { provided: false },
    }).map((l) => [l.tone, l.text]);
  const UNDECLARED =
    'Offline access: NOT DECLARED, so this app cannot get it. Its OAuth client could get refresh ' +
    'tokens, but because the listing does not declare offline access, the sign-in screen does not ' +
    'offer "Stay connected" and no refresh token is issued. Until offline access is a separate ' +
    'grant on the sign-in service, every app still receives refresh tokens.';
  const MISMATCH_UNREACHABLE =
    'Declaration MISMATCH: the listing declares offline access, but its OAuth client cannot ' +
    'get refresh tokens. The declaration does not describe this client.';
  const MISMATCH_DEVICE =
    'Declaration MISMATCH: the app uses the device flow, which always gets refresh tokens, but ' +
    'the listing does NOT declare offline access.';

  it('🔴 reachable but NOT declared → "this app cannot get offline access", not a REACHABLE warning', () => {
    const l = lines(true, false);
    expect(l[0]).toEqual(['warn', UNDECLARED]);
    expect(l.some(([, t]) => t.startsWith('Offline access: REACHABLE'))).toBe(false);
    expect(l.some(([, t]) => t.includes('Users are not told'))).toBe(false);
  });

  it('🔴 undeclared here, but ANOTHER listing on the client declares → it does not claim "cannot get it"', () => {
    const l = civitaiCheckLines({
      offlineAccess: {
        reachable: true,
        alwaysOffline: false,
        grants: [],
        declared: false,
        anotherListingDeclares: true,
      },
      source: { provided: false },
    }).map((x) => [x.tone, x.text]);
    expect(l[0]).toEqual([
      'warn',
      'Offline access: not declared on this listing, but another listing on this client declares ' +
        'offline access, so this app can still get it: users are offered "Stay connected" and the app ' +
        'can hold a refresh token.',
    ]);
    expect(l).not.toContainEqual(['warn', UNDECLARED]);
  });

  it('🔴 declared but NOT reachable → flagged', () => {
    expect(lines(false, true)).toContainEqual(['warn', MISMATCH_UNREACHABLE]);
  });

  it('🔴 a device-flow client (not gated by the hub) that does not declare → a mismatch, still ALWAYS', () => {
    const l = lines(true, false, true);
    expect(l[0][1]).toMatch(/^Offline access: ALWAYS\./);
    expect(l).toContainEqual(['warn', MISMATCH_DEVICE]);
    expect(l).not.toContainEqual(['warn', UNDECLARED]);
  });

  it('declared and reachable → REACHABLE, and the justification is what is left to judge', () => {
    const l = lines(true, true);
    expect(l[0][1]).toMatch(/^Offline access: REACHABLE\./);
    expect(l).toContainEqual([
      'info',
      'Offline access is declared and reachable. Judge the stated justification.',
    ]);
    expect(l.some(([, t]) => t.startsWith('Declaration MISMATCH'))).toBe(false);
  });

  it('neither → no declaration line at all', () => {
    expect(lines(false, false).some(([, t]) => /declar/i.test(t))).toBe(false);
  });

  it('checks stored before declarations existed (no `declared`) render as before', () => {
    const l = lines(true, undefined);
    expect(l[0][1]).toMatch(/^Offline access: REACHABLE\./);
    expect(l.some(([, t]) => /declar/i.test(t))).toBe(false);
  });
});

describe('offlineAccessDeclaration — what counts as declared', () => {
  it('a reason (trimmed) is a declaration', () => {
    expect(offlineAccessDeclaration({ offline_access: '  nightly sync ' })).toEqual({
      declared: true,
      justification: 'nightly sync',
    });
  });
  it.each([
    ['no key (a listing from before declarations)', {}],
    ['a blank value', { offline_access: '   ' }],
    ['a non-string value', { offline_access: 7 as unknown as string }],
    ['no map at all', null],
  ])('%s is NOT a declaration', (_label, j) => {
    expect(offlineAccessDeclaration(j)).toEqual({ declared: false, justification: null });
  });
});
