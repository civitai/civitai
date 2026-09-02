import { describe, it, expect } from 'vitest';
import { syncAccountFor } from '~/utils/sync-account';
import type { ServerDomains } from '~/shared/constants/domain.constants';

// `syncAccount()` stamps cross-colour links with `sync-account`, which is the ONLY trigger for the
// destination's bootstrap (useDomainSync -> /api/auth/authorize). It derived the current colour from
// `window.location.host`, so on the server it returned the url untouched — every SERVER-RENDERED
// cross-colour link shipped unstamped, and a browser arriving at the other colour without an existing
// session stayed signed out. Confirmed in prod, not just locally; it is masked in normal use because the
// destination's session cookie is 30-day rolling, so people are usually already signed in there.
//
// `syncAccountFor` takes the colour as an argument so it works during SSR. These tests deliberately never
// touch `window` — if the stamping silently depended on a browser again, every case here would fail.

const domains: ServerDomains = {
  green: { primary: 'civitai.com', aliases: [] },
  red: { primary: 'civitai.red', aliases: ['www.civitai.red'] },
  blue: { primary: 'civitai.blue', aliases: [] },
};

describe('syncAccountFor — works without a browser', () => {
  it('stamps a cross-colour link with the SOURCE colour', () => {
    expect(syncAccountFor('//civitai.red/models/1', 'green', domains)).toBe(
      '//civitai.red/models/1?sync-account=green'
    );
  });

  it('stamps an absolute url and an aliased host too', () => {
    expect(syncAccountFor('https://civitai.red/x', 'green', domains)).toContain('sync-account=green');
    expect(syncAccountFor('//www.civitai.red/x', 'green', domains)).toContain('sync-account=green');
  });

  it('preserves an existing query string', () => {
    const out = syncAccountFor('//civitai.red/search?query=cats', 'green', domains);
    expect(out).toContain('query=cats');
    expect(out).toContain('sync-account=green');
  });
});

describe('syncAccountFor — leaves everything else alone', () => {
  it.each([
    ['same colour', '//civitai.com/models/1', 'green' as const],
    ['a relative url', '/models/1', 'green' as const],
    ['an external host', '//example.com/x', 'green' as const],
  ])('%s', (_label, url, color) => {
    expect(syncAccountFor(url, color, domains)).toBe(url);
  });

  it('no current colour resolved', () => {
    expect(syncAccountFor('//civitai.red/x', undefined, domains)).toBe('//civitai.red/x');
  });

  it('no domain map yet', () => {
    expect(syncAccountFor('//civitai.red/x', 'green', undefined)).toBe('//civitai.red/x');
  });
});
