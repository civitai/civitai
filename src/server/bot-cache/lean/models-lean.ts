import type { IncomingMessage } from 'http';
import type { ParsedUrlQuery } from 'querystring';
import { truncate } from 'lodash-es';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { decideGatedState } from '~/components/Gated/gated-state';
import { resolveMetaHref } from '~/components/Meta/canonical';
import { modelOgEndpoint, ogImageUrl } from '~/components/Meta/og-image-url';
import { buildBreadcrumbSchema, getSiteSchema } from '~/components/Meta/site-schema';
import { env } from '~/env/client';
import type { BotLeanResult } from '~/server/bot-cache/bot-lean';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { getServerProxySSGHelpers } from '~/server/utils/server-side-helpers';
import {
  getAllServerHosts,
  getRequestDomainColor,
  serverDomainMap,
} from '~/server/utils/server-domain';
import { getBaseModelSeoName } from '~/shared/constants/basemodel.constants';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { VIEWPORT_META_CONTENT } from '~/shared/constants/app-layout.constants';
import { BOT_LEAN_CHROME_REQ_KEY } from '~/shared/constants/bot-cache.constants';
import { expandHiddenPreferences } from '~/shared/hidden-preferences/compact';
import { serializeJsonLd } from '@civitai/shared/json-ld';
import { getDisplayName, removeTags, slugit } from '~/utils/string-helpers';

/**
 * The lean page for `/models/[id]/[[...slug]]` (`~/server/bot-cache/bot-lean`): what a crawler
 * reads from the full server render of the model page for the anonymous, region-free viewer of a
 * bot-cache render, written as a string. Everything it shows comes from the page resolver's query
 * cache — `model.getById`, `image.getInfinite` (the carousel), `user.getCreator`,
 * `hiddenPreferences.getHidden` — the queries with data in that render.
 *
 * The resolver's own answers (404s, private models, the canonical-slug redirects) come before the
 * hook, so they are the full page's by construction. This file reproduces ONE shape of the page — a
 * published, safe-rated model the anonymous viewer may see, with no version in early access, no
 * archive/take-down mode, no cosmetics, around no site chrome — and answers `fallback` for everything
 * else, so the full render keeps answering every case it does not draw. Each function below names
 * the component whose server output it reproduces: `bot-lean-models-parity.test.ts` renders both
 * and fails on any difference a crawler can read.
 */

type Ssg = Awaited<ReturnType<typeof getServerProxySSGHelpers>>;
type Model = NonNullable<Awaited<ReturnType<Ssg['model']['getById']['fetch']>>>;
type Version = Model['modelVersions'][number];

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
};
/** Text and attribute values. */
export function esc(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

const attr = (name: string, value: unknown) =>
  value === undefined || value === null ? '' : ` ${name}="${esc(value)}"`;

function readQuery<T>(ssg: Ssg, queryKey: readonly unknown[]): { found: boolean; data?: T } {
  const state = ssg.queryClient.getQueryState(queryKey);
  if (!state) return { found: false };
  if (state.status !== 'success') return { found: true };
  return { found: true, data: state.data as T };
}

type CarouselImage = { url: string; nsfwLevel: number; name?: string | null; id: number };

/** The carousel's `image.getInfinite` prefetch (one per render), or `null` when it has no data. */
function carouselImages(ssg: Ssg): CarouselImage[] | null {
  const [query] = ssg.queryClient.getQueryCache().findAll({ queryKey: [['image', 'getInfinite']] });
  if (!query || query.state.status !== 'success') return null;
  const data = query.state.data as { pages?: { items?: CarouselImage[] }[] } | undefined;
  return (data?.pages ?? []).flatMap((page) => page.items ?? []);
}

/** Why the page is one this file does not draw, or `null` when it draws it. */
function unsupported(model: Model, versions: Version[]) {
  const row = model as unknown as {
    poi?: boolean;
    mode?: string | null;
    user: { cosmetics?: unknown[]; profilePicture?: unknown };
  };
  if (row.poi || row.mode) return true;
  if (row.user.cosmetics?.length || row.user.profilePicture) return true;
  return versions.some((version) => {
    const v = version as unknown as {
      earlyAccessDeadline?: Date | null;
      paidAccess?: unknown;
      inaccurate?: boolean;
    };
    return !!v.earlyAccessDeadline || !!v.paidAccess || !!v.inaccurate;
  });
}

export async function renderModelDetailLean({
  req,
  query,
  ssg,
  features,
}: {
  req: IncomingMessage;
  query: ParsedUrlQuery;
  ssg: Ssg;
  features: FeatureAccess;
}): Promise<BotLeanResult> {
  if ((req as { [BOT_LEAN_CHROME_REQ_KEY]?: boolean })[BOT_LEAN_CHROME_REQ_KEY] !== false)
    return { fallback: 'unsupported' };
  const id = Number(query.id);
  if (!Number.isInteger(id)) return { fallback: 'not-found' };

  const modelKey = ssg.model.getById.queryOptions({ id, excludeTrainingData: true }).queryKey;
  const model = readQuery<Model>(ssg, modelKey).data;
  // The page's PageLoader / NotFound / "removed by its owner" branches: not drawn here.
  if (!model) return { fallback: 'not-found' };
  if (model.status !== 'Published' || model.deletedAt) return { fallback: 'not-found' };
  const versions = model.modelVersions.filter((version) => version.status === 'Published');
  if (!versions.length) return { fallback: 'not-found' };
  type HiddenData = Parameters<typeof expandHiddenPreferences>[0];
  const hiddenKey = ssg.hiddenPreferences.getHidden.queryOptions().queryKey;
  const hidden = expandHiddenPreferences(readQuery<HiddenData>(ssg, hiddenKey).data);
  if (hidden.blockedUsers.some((u) => u.id === model.user.id)) return { fallback: 'not-found' };

  const { state } = decideGatedState({
    contentNsfwLevel: model.nsfwLevel,
    nsfw: model.nsfw && !model.hasSfwFace,
    bypassRating: false,
    canViewNsfw: !!features.canViewNsfw,
    signedIn: false,
    sessionLoading: false,
    verifiedBot: false,
  });
  if (state !== 'page') return { fallback: 'gated' };
  if (unsupported(model, versions)) return { fallback: 'unsupported' };
  const images = carouselImages(ssg);
  if (!images) return { fallback: 'unsupported' };

  const requested = Number(query.modelVersionId);
  const selected = versions.find((version) => version.id === requested) ?? versions[0]!;
  return { html: renderPage({ req, model, selected, versions, images, features }) };
}

function renderPage({
  req,
  model,
  selected,
  images,
}: {
  req: IncomingMessage;
  model: Model;
  selected: Version;
  versions: Version[];
  images: CarouselImage[];
  features: FeatureAccess;
}) {
  const baseUrl = env.NEXT_PUBLIC_BASE_URL ?? '';
  const host = (req.headers.host ?? '').toLowerCase();
  const canIndex = getAllServerHosts().includes(host);
  const ecosystem = getBaseModelSeoName(selected.baseModel);
  const typeName = getDisplayName(model.type);
  const title = `${model.name} - ${selected.name} | ${ecosystem} ${typeName} | Civitai`;
  const description = truncate(removeTags(model.description ?? ''), { length: 150 });
  const ogImage = ogImageUrl(modelOgEndpoint(model));
  const slug = slugit(model.name);
  const category = model.tagsOnModels.find(({ tag }) => !!tag.isCategory)?.tag;
  const safeImage = images.find((image) => getIsSafeBrowsingLevel(image.nsfwLevel));
  const thumbsUp = model.rank?.thumbsUpCountAllTime ?? 0;
  const thumbsDown = model.rank?.thumbsDownCountAllTime ?? 0;
  const ratings = thumbsUp + thumbsDown;
  const author =
    !model.user.deletedAt && model.user.username
      ? {
          '@type': 'Person',
          name: model.user.username,
          url: env.NEXT_PUBLIC_BASE_URL
            ? `${env.NEXT_PUBLIC_BASE_URL}/user/${model.user.username}`
            : undefined,
        }
      : { '@type': 'Person', name: 'Civitai user' };
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    applicationCategory: 'Multimedia',
    applicationSubCategory: `${ecosystem} Model`,
    description: removeTags(model.description ?? ''),
    name: model.name,
    image: safeImage ? getEdgeUrl(safeImage.url, { width: 1200 }) : undefined,
    author,
    datePublished: model.publishedAt,
    ...(ratings > 0 && {
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: Math.max(Math.min(Math.ceil((thumbsUp / ratings) * 5), 5), 1),
        reviewCount: ratings,
        bestRating: 5,
        worstRating: 1,
      },
    }),
  };
  const breadcrumb = buildBreadcrumbSchema(baseUrl, [
    { name: 'Models', path: '/models' },
    ...(category ? [{ name: category.name, path: `/tag/${encodeURIComponent(category.name)}` }] : []),
    { name: model.name },
  ]);
  const siteSchema = getSiteSchema({
    domain: getRequestDomainColor(req) ?? undefined,
    serverDomains: {
      green: serverDomainMap.green,
      blue: serverDomainMap.blue,
      red: serverDomainMap.red,
    },
  });
  const deIndex = model.availability === 'Unsearchable' || !canIndex;
  const jsonLd = (value: unknown) =>
    value ? `<script type="application/ld+json">${serializeJsonLd(value)}</script>` : '';
  // `next/head` keeps the last `<meta name="robots">`: noindex when it applies, else the preview.
  const robots = deIndex ? 'noindex,nofollow' : 'max-image-preview:large';
  const describe = description
    ? `<meta name="description"${attr('content', description)}>` +
      `<meta property="og:description"${attr('content', description)}>` +
      `<meta property="twitter:description"${attr('content', description)}>`
    : '';

  const head =
    `<meta charset="utf-8"><meta name="viewport" content="${esc(VIEWPORT_META_CONTENT)}">` +
    jsonLd(siteSchema) +
    `<title>${esc(title)}</title>` +
    `<meta name="title"${attr('content', title)}>` +
    `<meta property="og:title"${attr('content', title)}>` +
    `<meta property="twitter:title"${attr('content', title)}>` +
    describe +
    `<meta property="og:type" content="website">` +
    `<meta property="twitter:card" content="summary_large_image">` +
    `<meta property="og:image"${attr('content', ogImage)}>` +
    `<meta property="og:image:width" content="1200">` +
    `<meta property="og:image:height" content="630">` +
    `<meta property="twitter:image"${attr('content', ogImage)}>` +
    `<meta name="robots"${attr('content', robots)}>` +
    `<link rel="canonical"${attr('href', resolveMetaHref(`/models/${model.id}/${slug}`, baseUrl))}>` +
    `<link rel="alternate"${attr('href', resolveMetaHref(`/models/${model.id}`, baseUrl))}>` +
    jsonLd(schema) +
    jsonLd(breadcrumb);

  const body = `<main><h1>${esc(model.name)}</h1></main>`;
  return `<!DOCTYPE html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
}
