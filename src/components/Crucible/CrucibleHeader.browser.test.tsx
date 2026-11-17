import { describe, expect, test, vi } from 'vitest';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import type { CrucibleHeaderData } from '~/components/Crucible/CrucibleHeader';
import type * as AppProviderModule from '~/providers/AppProvider';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// Everything around the entry chip needs the app's providers; the count does not.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/Crucible/CrucibleContextMenu', () => ({ CrucibleContextMenu: () => null }));
vi.mock('~/components/Crucible/CrucibleFollowToggle', () => ({ CrucibleFollowToggle: () => null }));
vi.mock('~/components/Crucible/CrucibleUserLink', () => ({ CrucibleUserLink: () => null }));
vi.mock('~/components/Crucible/CrucibleContentBadges', () => ({
  CrucibleContentBadges: () => null,
}));
vi.mock('~/components/Crucible/CrucibleTimer', () => ({ CrucibleTimer: () => null }));
vi.mock('~/components/RatingReview/OwnerRatingControls', () => ({
  OwnerRatingControls: () => null,
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('~/components/User/Username', () => ({ Username: () => null }));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({ EdgeMedia: () => null }));
// Read on civitai.red. The domain config comes in through AppContext, as it does on the site, so
// the real useCurrentDomainHosts derives the hosts.
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AppProviderModule>()),
  useMaybeAppContext: () => ({
    host: 'civitai.red',
    serverDomains: {
      blue: { primary: 'civitai.com', aliases: [] },
      red: { primary: 'civitai.red', aliases: [] },
      green: { primary: 'civitai.green', aliases: [] },
    },
  }),
}));

const { CrucibleHeader } = await import('~/components/Crucible/CrucibleHeader');

const crucible = (rawEntries: number): CrucibleHeaderData => ({
  id: 154,
  name: 'Test crucible',
  description: null,
  status: CrucibleStatus.Active,
  nsfwLevel: 1,
  entryFee: 0,
  seededPrizePool: 0,
  buzzType: 'green',
  startAt: null,
  endAt: null,
  contentType: MediaType.image,
  user: { id: 1, username: 'host', deletedAt: null, image: null } as never,
  image: null,
  heroImage: null,
  _count: { entries: rawEntries },
  paidEntryCount: 0,
  entrantCount: 0,
});

const claimed = () => document.body.textContent?.match(/(\d+)\s(entry|entries)/)?.[0];
// The title renders first; the chip is read only once the header has drawn.
const drawn = () => vi.waitFor(() => expect(document.body.textContent).toContain('Test crucible'));

describe('CrucibleHeader entry count', () => {
  test('claims the entries the viewer can see listed, not every row', async () => {
    renderWithProviders(<CrucibleHeader crucible={crucible(5)} entryCount={4} />);

    await drawn();
    expect(claimed()).toBe('4 entries');
  });

  test('falls back to the row count until the listed count is known', async () => {
    renderWithProviders(<CrucibleHeader crucible={crucible(5)} />);

    await drawn();
    expect(claimed()).toBe('5 entries');
  });

  test('says "1 entry" for one', async () => {
    renderWithProviders(<CrucibleHeader crucible={crucible(3)} entryCount={1} />);

    await drawn();
    expect(claimed()).toBe('1 entry');
  });
});

describe('CrucibleHeader description links', () => {
  const renderDescription = async (description: string) => {
    renderWithProviders(
      <CrucibleHeader crucible={{ ...crucible(0), description }} entryCount={0} />
    );
    await drawn();
    return Array.from(
      document.querySelectorAll<HTMLAnchorElement>('[data-testid="crucible-description"] a')
    );
  };

  test('links an https URL with a safe rel and a new tab', async () => {
    const links = await renderDescription(
      'Song, timed lyrics and how it works: https://example.com/a'
    );
    const link = links[0];
    expect(link.getAttribute('href')).toBe('https://example.com/a');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('nofollow ugc noopener noreferrer');
  });

  test('links an http URL', async () => {
    const links = await renderDescription('see http://example.com/song');
    expect(links[0].getAttribute('href')).toBe('http://example.com/song');
  });

  test('links every URL, including an uppercase scheme', async () => {
    const links = await renderDescription('one HTTPS://example.com/a then https://example.org/b');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'HTTPS://example.com/a',
      'https://example.org/b',
    ]);
  });

  test.each([
    ['see https://example.com/articles/37938.', 'https://example.com/articles/37938'],
    ['(see https://example.com/articles/37938)', 'https://example.com/articles/37938'],
  ])('keeps trailing punctuation out of the href: %s', async (text, href) => {
    const links = await renderDescription(text);
    expect(links[0].getAttribute('href')).toBe(href);
  });

  test.each([
    'bare foo.com and www.example.org words',
    'mail me at someone@example.com',
    'javascript:alert(1) and mailto:a@b.co',
    'creds https://user:pass@example.com/x',
    'plain text with no url at all',
  ])('does not link: %s', async (text) => {
    const links = await renderDescription(text);
    expect(links).toHaveLength(0);
    expect(document.body.textContent).toContain(text);
  });

  test('does not interpret HTML in the description', async () => {
    await renderDescription('<b>bold</b> <img src=x onerror=alert(1)>');
    expect(document.querySelector('b')).toBeNull();
    expect(document.body.textContent).toContain('<b>bold</b>');
  });
});

// Own-site links render as root-relative paths so each site keeps its readers (.red must not link
// to .com); links elsewhere are left as written.
describe('CrucibleHeader description links to our own site', () => {
  const hrefsIn = async (description: string) => {
    renderWithProviders(
      <CrucibleHeader crucible={{ ...crucible(0), description }} entryCount={0} />
    );
    await drawn();
    return Array.from(
      document.querySelectorAll<HTMLAnchorElement>('[data-testid="crucible-description"] a')
    ).map((a) => a.getAttribute('href'));
  };

  test.each([
    ['Rules: /articles/38702', '/articles/38702'],
    ['Rules (/articles/38702).', '/articles/38702'],
    ['Rules: https://civitai.com/articles/38702', '/articles/38702'],
    ['Rules: HTTPS://Civitai.Green/articles/38702', '/articles/38702'],
    ['Rules: civitai.red/articles/38702?tab=x#c', '/articles/38702?tab=x#c'],
    ['Rules: civitai.com/articles/38702', '/articles/38702'],
  ])('links %s as %s', async (text, href) => {
    expect(await hrefsIn(text)).toEqual([href]);
  });

  test.each(['Rules: /articles/38702', 'Rules: https://civitai.com/articles/38702'])(
    'a same-site link opens in place, without the user-content rel: %s',
    async (text) => {
      await hrefsIn(text);
      const link = document.querySelector<HTMLAnchorElement>(
        '[data-testid="crucible-description"] a'
      )!;
      expect(link.getAttribute('href')).toBe('/articles/38702');
      expect(link.getAttribute('target')).toBeNull();
      expect(link.getAttribute('rel')).toBeNull();
    }
  );

  test('control: a link to another site keeps its host', async () => {
    expect(await hrefsIn('see https://example.com/articles/38702')).toEqual([
      'https://example.com/articles/38702',
    ]);
  });

  // The cross-site link ("visit civitai.red") only works if it keeps its host.
  test('leaves a bare homepage link absolute', async () => {
    expect(await hrefsIn('also on https://civitai.red')).toEqual(['https://civitai.red']);
  });

  // Made relative, its path "//evil.com/x" would be a link off the site.
  test('an own-host link whose path starts "//" keeps its host', async () => {
    expect(await hrefsIn('see https://civitai.com//evil.com/x')).toEqual([
      'https://civitai.com//evil.com/x',
    ]);
  });

  test('an encoded slash stays on this site', async () => {
    const [href] = await hrefsIn('see /%2F%2Fevil.com');
    expect(href).toBe('/%2F%2Fevil.com');
    expect(new URL(href!, 'https://civitai.red').host).toBe('civitai.red');
  });

  test.each([
    'protocol-relative //evil.com/x',
    'backslash /\\evil.com',
    'tab /\t/evil.com',
    'newline /\n/evil.com',
    'creds https://user:pw@civitai.com/x',
    'look-alike civitai.com.evil.test/x',
    'bare third party example.com/x',
    // Linked, a bare mention of our homepage would point at the other site.
    'bare homepage civitai.com and civitai.red',
    'and/or and 1/2',
  ])('does not link: %s', async (text) => {
    expect(await hrefsIn(text)).toEqual([]);
    expect(document.querySelector('[data-testid="crucible-description"]')?.textContent).toBe(text);
  });
});
