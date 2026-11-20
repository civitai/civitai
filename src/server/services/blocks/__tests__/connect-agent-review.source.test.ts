import { describe, expect, it, vi } from 'vitest';
import {
  commitShaFromArchiveUrl,
  connectSourceArchiveUrl,
  withServerFacts,
  type ConnectServerFacts,
} from '~/server/services/blocks/connect-agent-review.logic';
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
      { allowUrl: (u: URL) => boolean; maxBytes: number; maxRedirects: number }
    ];
    expect(url).toBe('https://github.com/ann/photo-sync/archive/HEAD.zip');
    expect(opts.maxBytes).toBe(25 * 1024 * 1024);
    expect(opts.maxRedirects).toBe(2);
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

describe('withServerFacts', () => {
  const fact = { origin: 'civitai', title: 'No server source provided', summaryLine: 'x' };
  const facts = {
    scopeVerdicts: [],
    securityAudit: [],
    codeReview: [fact],
  } as unknown as ConnectServerFacts;

  it('a runner entry claiming Civitai origin is dropped; the stored fact leads', () => {
    expect(
      withServerFacts('codeReview', facts, {
        notes: 'n',
        findings: [{ origin: 'civitai', title: 'Server source reviewed' }, { title: 'real' }],
      })
    ).toEqual({ notes: 'n', findings: [fact, { title: 'real' }] });
  });

  it('a failure marker is returned untouched', () => {
    expect(withServerFacts('codeReview', facts, 'Traceback')).toBe('Traceback');
  });

  it('an absent section is the facts alone, in the section shape', () => {
    expect(withServerFacts('codeReview', facts, undefined)).toEqual({
      findings: [fact],
      priorFindingsReconciled: [],
    });
  });
});
