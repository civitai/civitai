import { describe, expect, it } from 'vitest';

import {
  MAX_EXTERNAL_URL_LENGTH,
  MAX_REPOSITORY_URL_LENGTH,
  REPOSITORY_HOST_ALLOWLIST,
  validateRepositoryUrl,
} from '~/server/schema/blocks/external-app.schema';

/**
 * `validateRepositoryUrl` — the ONE rule for a public source-repository link, shared by
 * the on-site manifest path (`BlockManifestValidator`, key `repository`) and the
 * off-site listing path (`submitExternalListing` / `buildListingPatchData`, column
 * `sourceRepoUrl`).
 *
 * Two things this suite is written to establish, in this order:
 *
 *   1. 🔴 THE ALLOWLIST IS NOT VACUOUSLY REJECTING EVERYTHING. A host allowlist that
 *      rejects its own accepted hosts passes every negative case in the table and would
 *      look thoroughly tested. So each of the three hosts gets an explicit PASSING case
 *      first, and every passing case asserts the NORMALISED output rather than merely
 *      `ok: true` — `ok` alone cannot see a normaliser that returns the wrong string.
 *
 *   2. The rejections, each naming the shape it stands for rather than "invalid URL".
 */

/** Assert a PASS and pin the exact canonical output. */
function expectCanonical(input: string, canonical: string) {
  const res = validateRepositoryUrl(input);
  expect(res, `expected ${JSON.stringify(input)} to be accepted`).toEqual({
    ok: true,
    url: canonical,
  });
}

/** Assert a REJECT and return the message, so a case can pin WHY it was rejected. */
function expectRejected(input: unknown): string {
  const res = validateRepositoryUrl(input);
  expect(res.ok, `expected ${JSON.stringify(input)} to be REJECTED`).toBe(false);
  return res.ok ? '' : res.error;
}

describe('validateRepositoryUrl — the allowlist ACCEPTS its own hosts', () => {
  // 🔴 THE POSITIVE CONTROL for the whole suite. Without these, a validator hardcoded
  // to `{ok:false}` satisfies every other test in this file.
  it.each([
    ['github.com', 'https://github.com/civitai/civitai', 'https://github.com/civitai/civitai'],
    ['gitlab.com', 'https://gitlab.com/some-org/some-app', 'https://gitlab.com/some-org/some-app'],
    [
      'codeberg.org',
      'https://codeberg.org/forgejo/forgejo',
      'https://codeberg.org/forgejo/forgejo',
    ],
  ])('accepts a repository root on %s', (_host, input, canonical) => {
    expectCanonical(input, canonical);
  });

  it('the three accepted hosts ARE exactly REPOSITORY_HOST_ALLOWLIST — no fourth, no missing one', () => {
    // Structural, so adding a host to the const without adding a case above is visible.
    expect([...REPOSITORY_HOST_ALLOWLIST]).toEqual(['github.com', 'gitlab.com', 'codeberg.org']);
    for (const host of REPOSITORY_HOST_ALLOWLIST) {
      expectCanonical(`https://${host}/owner/repo`, `https://${host}/owner/repo`);
    }
  });

  it('accepts the punctuation real repo names use (dots, dashes, underscores)', () => {
    expectCanonical(
      'https://github.com/my-org_1/my.app-v2_beta',
      'https://github.com/my-org_1/my.app-v2_beta'
    );
  });
});

describe('validateRepositoryUrl — NORMALISATION (equality is load-bearing downstream)', () => {
  // The off-site material-change check compares a proposed link against the live one to
  // decide whether an edit re-enters MODERATOR REVIEW. If these spellings did not
  // collapse to one value, re-saving an unchanged form would queue a pointless review.
  it.each([
    ['trailing slash', 'https://github.com/civitai/civitai/'],
    ['trailing .git', 'https://github.com/civitai/civitai.git'],
    ['trailing .GIT (case-insensitive)', 'https://github.com/civitai/civitai.GIT'],
    ['trailing .git AND slash', 'https://github.com/civitai/civitai.git/'],
    ['uppercase host', 'https://GITHUB.COM/civitai/civitai'],
    ['mixed-case host', 'https://GitHub.Com/civitai/civitai'],
    ['surrounding whitespace', '   https://github.com/civitai/civitai   '],
    ['a query string', 'https://github.com/civitai/civitai?tab=readme'],
    ['a fragment', 'https://github.com/civitai/civitai#install'],
    ['query AND fragment AND .git', 'https://github.com/civitai/civitai.git?x=1#y'],
  ])('%s normalises to the canonical form', (_label, input) => {
    expectCanonical(input, 'https://github.com/civitai/civitai');
  });

  it('the OWNER and REPO case is PRESERVED (only the host is lower-cased)', () => {
    // GitHub paths are case-preserving; lower-casing them would produce a link that
    // redirects at best and 404s at worst. The host is a DNS name, so lower-casing that
    // is correct. Two different facts, one function — assert them apart.
    expectCanonical('https://GITHUB.COM/CivitAI/CivitAI', 'https://github.com/CivitAI/CivitAI');
  });

  it('every accepted output is itself accepted, unchanged (idempotent)', () => {
    for (const raw of [
      'https://github.com/a/b.git/',
      'https://GITLAB.COM/x/y?z=1',
      'https://codeberg.org/p/q#frag',
    ]) {
      const once = validateRepositoryUrl(raw);
      expect(once.ok).toBe(true);
      if (!once.ok) return;
      expect(validateRepositoryUrl(once.url)).toEqual({ ok: true, url: once.url });
    }
  });
});

describe('validateRepositoryUrl — HOST rejections (an exact allowlist, not a suffix test)', () => {
  it.each([
    // The two that make a suffix match dangerous rather than merely sloppy: both serve
    // ATTACKER-AUTHORED content under a github.com-shaped name.
    ['gist.github.com', 'https://gist.github.com/someone/deadbeef'],
    ['raw.githubusercontent.com', 'https://raw.githubusercontent.com/o/r/main/x.sh'],
    // `www.` is the ordinary mistake, and it must fail for the same structural reason.
    ['www.github.com', 'https://www.github.com/civitai/civitai'],
    ['a lookalike domain', 'https://github.com.evil.example/civitai/civitai'],
    ['a substring domain', 'https://evil-github.com/civitai/civitai'],
    ['an unrelated host', 'https://bitbucket.org/civitai/civitai'],
    // 🔴 HOMOGLYPH: `gіthub.com` with a Cyrillic `і` (U+0456). The WHATWG parser
    // punycodes it to `xn--github-fmc.com`, so an exact-host comparison rejects it —
    // but only because the comparison happens AFTER parsing, on `hostname`.
    ['a Cyrillic homoglyph domain', 'https://gіthub.com/civitai/civitai'],
  ])('rejects %s', (_label, input) => {
    expect(expectRejected(input)).toMatch(/not an accepted source host/);
  });

  it('rejects an allowlisted host carrying a PORT', () => {
    expect(expectRejected('https://github.com:8443/civitai/civitai')).toMatch(
      /must not specify a port/
    );
  });
});

describe('validateRepositoryUrl — PATH rejections (the repository ROOT, nothing else)', () => {
  it.each([
    ['the bare host root', 'https://github.com'],
    ['the bare host root with a slash', 'https://github.com/'],
    ['a single-segment path (owner only)', 'https://github.com/civitai'],
    ['a single-segment path with a slash', 'https://github.com/civitai/'],
    ['a deep path (tree/main)', 'https://github.com/civitai/civitai/tree/main'],
    ['a deep path (issues)', 'https://github.com/civitai/civitai/issues/42'],
    ['a repo segment that is ONLY .git', 'https://github.com/civitai/.git'],
    ['a percent-encoded slash smuggled into a segment', 'https://github.com/a%2Fb/c'],
    ['an @ in a segment', 'https://github.com/own@er/repo'],
    ['an owner starting with a dot', 'https://github.com/.hidden/repo'],
  ])('rejects %s', (_label, input) => {
    expect(expectRejected(input)).toMatch(/must point at a repository root/);
  });
});

describe('validateRepositoryUrl — INHERITED rules (delegated to validateExternalUrl)', () => {
  // These are `validateExternalUrl`'s rules, re-asserted here because this function is
  // the one the manifest + listing paths actually call: if the delegation were ever
  // dropped, these would go green through a re-implementation that missed one.
  it('rejects http://', () => {
    expect(expectRejected('http://github.com/civitai/civitai')).toMatch(/https:\/\/ URL/);
  });

  it('rejects embedded credentials (the display-vs-real-host phishing shape)', () => {
    // `https://github.com@evil.example/...` DISPLAYS as github.com and RESOLVES to
    // evil.example. Rejected on the credentials rule, before the host check.
    expect(expectRejected('https://user:pass@github.com/civitai/civitai')).toMatch(
      /must not contain credentials/
    );
    expect(expectRejected('https://github.com@evil.example/a/b')).toMatch(
      /must not contain credentials/
    );
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['a relative path', '/civitai/civitai'],
    ['a scheme-less host', 'github.com/civitai/civitai'],
    ['gibberish', 'not a url at all'],
  ])('rejects %s', (_label, input) => {
    expect(expectRejected(input)).toBeTruthy();
  });

  it('every inherited error names sourceRepoUrl, not externalUrl', () => {
    // The author filled in a field called "Source repository"; an error message about
    // `externalUrl` sends them to the wrong input. Relabelling is the reason the
    // delegation is a wrapper rather than a bare call.
    for (const bad of ['http://github.com/a/b', 'https://u:p@github.com/a/b', 'nonsense']) {
      const msg = expectRejected(bad);
      expect(msg, bad).toContain('sourceRepoUrl');
      expect(msg, bad).not.toContain('externalUrl');
    }
  });
});

describe('validateRepositoryUrl — LENGTH and non-string input', () => {
  it('rejects at exactly MAX_REPOSITORY_URL_LENGTH + 1 and accepts at the bound', () => {
    // 🔴 A REACHABLE BOUNDARY PAIR, not a "very long string". The over-length value must
    // otherwise be VALID (allowlisted host, two segments) or it would be rejected by the
    // path rule and this would prove nothing about the length check.
    const prefix = 'https://github.com/civitai/';
    const atBound = prefix + 'r'.repeat(MAX_REPOSITORY_URL_LENGTH - prefix.length);
    expect(atBound).toHaveLength(MAX_REPOSITORY_URL_LENGTH);
    expectCanonical(atBound, atBound);

    const overBound = atBound + 'r';
    expect(overBound).toHaveLength(MAX_REPOSITORY_URL_LENGTH + 1);
    expect(expectRejected(overBound)).toMatch(new RegExp(`≤ ${MAX_REPOSITORY_URL_LENGTH} chars`));
  });

  it('🔴 the repository bound BINDS — it is not shadowed by the looser external bound', () => {
    // `validateExternalUrl`'s cap is 2048, an order of magnitude looser. If the length
    // check ran AFTER the delegation, this value would sail past it and be rejected (if
    // at all) for some other reason. It is a valid repository URL in every other respect,
    // so the ONLY thing that can reject it is this function's own bound.
    expect(MAX_REPOSITORY_URL_LENGTH).toBeLessThan(MAX_EXTERNAL_URL_LENGTH);
    const between = 'https://github.com/civitai/' + 'r'.repeat(MAX_EXTERNAL_URL_LENGTH - 100);
    expect(between.length).toBeGreaterThan(MAX_REPOSITORY_URL_LENGTH);
    expect(between.length).toBeLessThan(MAX_EXTERNAL_URL_LENGTH);
    expect(expectRejected(between)).toMatch(new RegExp(`≤ ${MAX_REPOSITORY_URL_LENGTH} chars`));
  });

  it('rejects the empty string and whitespace-only input as EMPTY, not as malformed', () => {
    expect(expectRejected('')).toMatch(/must not be empty/);
    expect(expectRejected('   ')).toMatch(/must not be empty/);
    expect(expectRejected('\n\t ')).toMatch(/must not be empty/);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', { url: 'https://github.com/a/b' }],
    ['an array', ['https://github.com/a/b']],
    ['a boolean', true],
  ])('rejects %s without throwing', (_label, input) => {
    expect(() => validateRepositoryUrl(input)).not.toThrow();
    expect(expectRejected(input)).toMatch(/must be a string/);
  });
});
