import type { ColorDomain, ServerDomains } from '~/shared/constants/domain.constants';

/**
 * Real destinations for the `/discord`-style redirects the footer links through
 * (see the redirect table in next.config.mjs). `sameAs` must name the profile
 * itself — a redirect on our own host proves nothing about account ownership.
 */
const SOCIAL_PROFILES = [
  'https://twitter.com/HelloCivitai',
  'https://discord.gg/civitai',
  'https://www.youtube.com/@civitai',
  'https://www.instagram.com/hellocivitai/',
  'https://www.tiktok.com/@hellocivitai',
  'https://reddit.com/r/civitai',
  'https://www.twitch.tv/civitai',
  'https://github.com/civitai/civitai',
];

const ORGANIZATION_DESCRIPTION =
  'Civitai is an open platform for sharing, discovering and running AI image and video models — checkpoints, LoRAs and embeddings — with an in-browser generator and model training.';

function httpsUrl(host: string) {
  return `https://${host}`;
}

/**
 * Site-wide JSON-LD: who publishes this site, and which site this is.
 *
 * Emitted on every page, alongside (not instead of) whatever entity schema the
 * page itself declares — a page may carry several JSON-LD blocks.
 *
 * 🔴 The `Organization` node, and with it `sameAs`, is GREEN ONLY. Green and red
 * are separate web properties, and `sameAs` is what ties our social accounts into
 * the entity graph; pointing those accounts at the mature domain is a brand
 * decision, not a technical one, and it is not ours to make by default. Red still
 * gets its own `WebSite` node so the property is identified — it just is not
 * attributed to the Organization. Widening this is a one-line change if that
 * decision is ever made deliberately.
 */
export function getSiteSchema({
  domain,
  serverDomains,
}: {
  domain: ColorDomain;
  serverDomains: ServerDomains;
}) {
  const host = serverDomains[domain]?.primary;
  if (!host) return undefined;

  const siteUrl = httpsUrl(host);
  const greenHost = serverDomains.green?.primary;

  // No `potentialAction`/`SearchAction`: robots.txt deliberately disallows
  // `/search/*` and `*?query=` as thin duplicate content, so declaring a search
  // target would contradict a rule we want to keep — for a feature Google has
  // been winding down since 2024.
  const website = {
    '@type': 'WebSite',
    '@id': `${siteUrl}/#website`,
    url: siteUrl,
    name: 'Civitai',
    inLanguage: 'en',
  };

  if (domain !== 'green' || !greenHost) {
    return { '@context': 'https://schema.org', '@graph': [website] };
  }

  const greenUrl = httpsUrl(greenHost);

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        ...website,
        publisher: { '@id': `${greenUrl}/#organization` },
      },
      {
        '@type': 'Organization',
        '@id': `${greenUrl}/#organization`,
        name: 'Civitai',
        url: greenUrl,
        description: ORGANIZATION_DESCRIPTION,
        logo: {
          '@type': 'ImageObject',
          url: `${greenUrl}/images/logo_light_mode.png`,
        },
        sameAs: SOCIAL_PROFILES,
      },
    ],
  };
}

export type BreadcrumbItem = {
  name: string;
  /** Site-relative path, e.g. `/models/123/slug`. Omit on the final crumb. */
  path?: string;
};

/**
 * `BreadcrumbList` for a detail page. Google reads it both as a rich result and
 * as a statement about where the page sits in the site's hierarchy.
 *
 * The last item should omit `path`: the current page is the end of the trail, and
 * an `item` pointing at itself adds nothing.
 */
export function buildBreadcrumbSchema(baseUrl: string, items: BreadcrumbItem[]) {
  if (!items.length) return undefined;

  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(({ name, path }, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name,
      ...(path ? { item: `${baseUrl}${path}` } : {}),
    })),
  };
}
