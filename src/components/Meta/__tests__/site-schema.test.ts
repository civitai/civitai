import { describe, expect, it } from 'vitest';
import { getSiteSchema } from '~/components/Meta/site-schema';
import type { ServerDomains } from '~/shared/constants/domain.constants';

const serverDomains: ServerDomains = {
  green: { primary: 'civitai.green', aliases: [] },
  blue: { primary: 'civitai.com', aliases: [] },
  red: { primary: 'civitai.red', aliases: [] },
};

describe('getSiteSchema', () => {
  // `MyApp.getInitialProps` returns early when `ctx.req` is absent, so a client-side
  // route change re-renders `_app` with no `domain`/`serverDomains` at all. Indexing
  // them unguarded threw out of render and tripped the app-level error boundary on
  // every in-app navigation (v5.1.101).
  it('returns undefined instead of throwing when the props are absent', () => {
    expect(getSiteSchema({ domain: undefined, serverDomains: undefined })).toBeUndefined();
    expect(getSiteSchema({ domain: 'green', serverDomains: undefined })).toBeUndefined();
    expect(getSiteSchema({ domain: undefined, serverDomains })).toBeUndefined();
  });

  it('returns undefined when the domain has no configured host', () => {
    expect(
      getSiteSchema({ domain: 'red', serverDomains: { ...serverDomains, red: undefined } })
    ).toBeUndefined();
  });

  it('attributes the green site to the Organization', () => {
    const schema = getSiteSchema({ domain: 'green', serverDomains });
    expect(schema?.['@graph'].map((node) => node['@type'])).toEqual(['WebSite', 'Organization']);
  });

  it('gives a non-green domain a WebSite node with no Organization', () => {
    const schema = getSiteSchema({ domain: 'blue', serverDomains });
    expect(schema?.['@graph']).toHaveLength(1);
    expect(schema?.['@graph'][0]).toMatchObject({ '@type': 'WebSite', url: 'https://civitai.com' });
  });
});
