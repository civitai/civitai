import type { IncomingMessage } from 'http';
import type { ParsedUrlQuery } from 'querystring';
import { uniqBy } from 'lodash-es';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { decideGatedState } from '~/components/Gated/gated-state';
import { imageDetailGateLevel } from '~/components/Image/DetailV2/image-detail-gate';
import {
  imageDetailMainImageUrl,
  isImageDetailPoiHidden,
} from '~/components/Image/DetailV2/image-detail-main-media';
import { buildImageMediaSchema } from '~/components/Image/DetailV2/image-media-schema';
import { getRemixKinds } from '~/components/Image/Remix/remix.utils';
import { ogImageUrl } from '~/components/Meta/og-image-url';
import { resolveMetaHref } from '~/components/Meta/canonical';
import { buildBreadcrumbSchema, getSiteSchema } from '~/components/Meta/site-schema';
import { env } from '~/env/client';
import type { BotLeanResult } from '~/server/bot-cache/bot-lean';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { getServerProxySSGHelpers } from '~/server/utils/server-side-helpers';
import { getRequestDomainColor, serverDomainMap } from '~/server/utils/server-domain';
import { constants } from '~/server/common/constants';
import { VIEWPORT_META_CONTENT } from '~/shared/constants/app-layout.constants';
import { BOT_LEAN_CHROME_REQ_KEY } from '~/shared/constants/bot-cache.constants';
import { expandHiddenPreferences } from '~/shared/hidden-preferences/compact';
import { serializeJsonLd } from '@civitai/shared/json-ld';
import { sortByModelTypes } from '~/utils/array-helpers';
import { getDisplayName, getInitials, getModelUrl, slugit } from '~/utils/string-helpers';

/**
 * The lean page for `/images/[imageId]` (`~/server/bot-cache/bot-lean`): what a crawler reads from
 * the full server render of `ImageDetail2` for the anonymous, region-free viewer of a bot-cache
 * render, written as a string. Everything it shows comes from the page resolver's query cache
 * (`resolveImageDetailPageData`): `image.get`, `image.getGenerationData` and
 * `hiddenPreferences.getHidden`, the only queries with data in that render.
 *
 * It reproduces ONE shape of the page — a safe-rated still image the viewer may see, with no
 * cosmetics, no external metadata and no workflow, around no site chrome — and answers `fallback`
 * for everything else, so the full render keeps answering every case this file does not draw. Each
 * function below names the component whose server output it reproduces, down to the text of
 * buttons that do nothing without scripts: `bot-lean-images-parity.test.ts` renders both and fails
 * on any difference a crawler can read.
 */

type Ssg = Awaited<ReturnType<typeof getServerProxySSGHelpers>>;
type ImageRow = NonNullable<Awaited<ReturnType<Ssg['image']['get']['fetch']>>>;
type GenerationData = Awaited<ReturnType<Ssg['image']['getGenerationData']['fetch']>>;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
};
/** Text and attribute values. */
function esc(value: unknown) {
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

/**
 * `AnimatedCount` → `CustomNumberFlow`: the formatted value (screen-reader text), then one
 * aria-hidden column per character — a digit column holds the digits 0-9 on ten lines.
 */
const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const fullFormatter = new Intl.NumberFormat('en-US');
const DIGIT_STACK_TEXT = '0\n1\n2\n3\n4\n5\n6\n7\n8\n9';
function count(value: number, abbreviate: boolean) {
  const formatted = (abbreviate ? compactFormatter : fullFormatter).format(value);
  const columns = [...formatted]
    .map((char) => (/^[0-9]$/.test(char) ? DIGIT_STACK_TEXT : esc(char)))
    .map((column) => `<span aria-hidden="true">${column}</span>`)
    .join('');
  return `<span><span>${esc(formatted)}</span>${columns}</span>`;
}

/**
 * `ImageDetailReactions` → `Reactions` for a signed-out viewer: the reactions with a count (the
 * "Add reaction" button is icons only), then the Buzz tip count, shown even at zero.
 */
function reactions(image: ImageRow) {
  const stats = image.stats;
  const metrics: Record<string, number> = {
    Like: stats?.likeCountAllTime ?? 0,
    Heart: stats?.heartCountAllTime ?? 0,
    Laugh: stats?.laughCountAllTime ?? 0,
    Cry: stats?.cryCountAllTime ?? 0,
  };
  // `Reactions`' `keys` order, filtered to the image's available reactions, zeros hidden.
  const order = (Object.keys(constants.availableReactions) as string[]).filter(
    (key) => key in metrics
  );
  const emoji = constants.availableReactions as Record<string, string>;
  const badge = (key: string) => {
    const content = `<span>${esc(emoji[key])}</span> ${count(metrics[key]!, false)}`;
    return `<button aria-label="${esc(key)} reaction">${content}</button>`;
  };
  const badges = order.filter((key) => metrics[key]! >= 1).map(badge);
  const tipped = stats?.tippedAmountCountAllTime ?? 0;
  const tip = image.poi ? '' : `<span>${count(tipped, true)}</span>`;
  return `<div>${badges.join('')}${tip}</div>`;
}

/** `ImageDetail2`'s `renderLeftImageControls`: the buttons do nothing without scripts. */
function imageControls(image: ImageRow, url: string, features: FeatureAccess) {
  const source = { id: image.id, url, type: image.type, nsfwLevel: image.nsfwLevel };
  const remix = getRemixKinds(source).length > 0 ? '<button type="button">Remix</button>' : '';
  const post = image.postId ? `<a href="/posts/${esc(image.postId)}">View Post</a>` : '';
  const tip = !image.poi && features.buzz ? '<button type="button">Tip</button>' : '';
  return `${remix}<button type="button">Save</button>${post}${tip}`;
}

/** `SmartCreatorCard` → `CreatorCardSimple` with no `user.getCreator` data. */
function creatorCard(image: ImageRow) {
  const user = image.user;
  const username = user.username && !user.deletedAt ? user.username : null;
  // `UserAvatar`: Mantine's `Avatar` with the edge URL, or its initials when there is no image.
  const src = user.image ? getEdgeUrl(user.image, { width: 96, optimized: true }) : null;
  const alt = username ? `${username}'s Avatar` : undefined;
  const avatar = src
    ? `<img${attr('src', src)}${attr('alt', alt)} loading="lazy">`
    : `<span>${esc(username ? getInitials(username) : '')}</span>`;
  // `DaysFromNow` renders nothing on the server.
  const subText = image.publishedAt ? 'Uploaded' : 'Not published';
  const inner = `${avatar}<span>${esc(username ?? '[deleted]')}</span><p>${subText}</p>`;
  // `UserProfileLink`'s `/user/<username>`, as Next's `Link` resolves it (`new URL`).
  const profile = username ? new URL(`/user/${username}`, 'http://n').pathname : null;
  return (
    '<section><img src="/images/civitai-default-account-bg.png"' +
    ' alt="default creator card background decoration">' +
    (profile ? `<a href="${esc(profile)}">${inner}</a>` : inner) +
    '<button type="button">Follow</button></section>'
  );
}

/** `ImageProcess`. */
function processCard(data: GenerationData) {
  const { tools, techniques } = data;
  if (!tools.length && !techniques.length) return '';
  // A tool's link is the `as` path, `/tools/<slug>`; its notes are in a closed popover.
  const tool = ({ name }: { name: string }) =>
    `<li><a href="/tools/${esc(slugit(name))}">${esc(name)}</a></li>`;
  const technique = ({ name, notes }: { name: string; notes: string | null }) =>
    `<li><p>${esc(name)}</p>${notes ? `<p>${esc(notes)}</p>` : ''}</li>`;
  const toolList = tools.length ? `<h3>Tools</h3><ul>${tools.map(tool).join('')}</ul>` : '';
  const techniqueItems = techniques.map(technique).join('');
  const techniqueList = techniques.length ? `<h3>Techniques</h3><ul>${techniqueItems}</ul>` : '';
  return `<section><h2>Process</h2>${toolList}${techniqueList}</section>`;
}

const RESOURCE_LIMIT = 3;

/** `ImageResources`, as the server renders it: the first three, then "Show N more". */
function resourcesList(data: GenerationData) {
  const resources = uniqBy(data.resources ?? [], 'versionId')
    .map((resource) => ({ ...resource, isAvailable: resource.versionId !== null }))
    .sort((a, b) => (a.isAvailable === b.isAvailable ? 0 : a.isAvailable ? -1 : 1));
  if (!resources.length) return '';
  const items = sortByModelTypes(resources).slice(0, RESOURCE_LIMIT);
  const html = items.map((resource) => {
    const href = resource.modelId
      ? getModelUrl({
          modelId: resource.modelId,
          modelName: resource.modelName,
          modelVersionId: resource.versionId,
        })
      : null;
    const wrap = (inner: string) => (href ? `<a href="${esc(href)}">${inner}</a>` : inner);
    const strength = resource.strength ? `<span>${esc(resource.strength)}</span>` : '';
    const type = resource.modelType
      ? `<span>${esc(getDisplayName(resource.modelType))}</span>${strength}`
      : '';
    const version = resource.versionName ? wrap(`<p>${esc(resource.versionName)}</p>`) : '';
    return `<li>${wrap(`<p>${esc(resource.modelName)}</p>`)}${type}${version}</li>`;
  });
  const more =
    resources.length > RESOURCE_LIMIT
      ? `<p>Show ${resources.length - RESOURCE_LIMIT} more</p>`
      : '';
  return `<h3>Resources used</h3><ul>${html.join('')}</ul>${more}`;
}

/** `ImageMeta`'s "Other metadata" entries. */
function simpleMeta(data: GenerationData) {
  const meta = (data.meta ?? {}) as Record<string, unknown>;
  const { prompt: _p, negativePrompt: _n, ...rest } = meta;
  const candidates = data.onSite && data.displayKeys ? data.displayKeys : Object.keys(rest);
  return candidates
    .filter(
      (key) =>
        key !== 'comfy' &&
        key !== 'prompt' &&
        key !== 'negativePrompt' &&
        !/^[A-Z]/.test(key) &&
        meta[key] != null
    )
    .map((key) => ({ key, value: meta[key] }))
    .filter(({ value }) => !!value && typeof value !== 'object' && typeof value !== 'boolean');
}

/** `ImageGenerationData` (collapsible, open on the server): `ImageResources`, `ImageMeta`. */
function generationCard(data: GenerationData) {
  const meta = data.meta as Record<string, unknown> | undefined;
  if (!meta && !data.resources?.length) return '';
  const resources = resourcesList(data);
  let metaHtml = '';
  if (meta) {
    const software =
      (meta.software as string | undefined) ??
      (data.onSite ? 'Civitai Generator' : 'External Generator');
    const badges = `<span>${esc(software)}</span><span>${esc(data.process ?? '')}</span>`;
    const prompt = meta.prompt as string | undefined;
    const negative = meta.negativePrompt as string | undefined;
    const others = simpleMeta(data)
      .map(({ key, value }) => `<li><span>${esc(key)}:</span><span>${esc(value)}</span></li>`)
      .join('');
    metaHtml =
      (prompt ? `<h3>Prompt</h3>${badges}<p>${esc(prompt)}</p>` : badges) +
      (negative ? `<h3>Negative prompt</h3><p>${esc(negative)}</p>` : '') +
      (others ? `<h3>Other metadata</h3><ul>${others}</ul>` : '');
  }
  const copyAll = meta ? '<button type="button">COPY ALL</button>' : '';
  return `<section><h2>Generation data</h2>${copyAll}${resources}${metaHtml}</section>`;
}

/** The "Discussion" card for a signed-out reader: the comment list is still loading. */
function discussionCard(imageId: number) {
  return (
    `<section><h2>Discussion</h2><p>You must ` +
    `<a href="/login?returnUrl=/images/${esc(imageId)}" rel="nofollow">sign in</a>` +
    ` to add a comment</p></section>`
  );
}

/** Whether the image is one this file does not draw, so the full render must answer. */
function unsupported(row: ImageRow, data: GenerationData | undefined) {
  // Loosely typed on purpose: `image.get` answers a union (with and without media), and these
  // are presence checks on fields either side may lack.
  const image = row as unknown as {
    type: string;
    url: string | null;
    cosmetic?: unknown;
    eventDecoration?: unknown;
    user: { profilePicture?: unknown; cosmetics?: unknown[] };
    stats?: { statsUnknown?: boolean };
    blockedFor?: unknown;
    needsReview?: unknown;
  };
  if (image.type !== 'image' || !image.url) return true;
  if (image.cosmetic || image.eventDecoration) return true;
  if (image.user.profilePicture || image.user.cosmetics?.length) return true;
  if (image.stats?.statsUnknown) return true;
  if (image.blockedFor || image.needsReview) return true;
  if (data) {
    if (data.external) return true;
    const meta = data.meta as Record<string, unknown> | undefined;
    if (meta?.comfy) return true;
  }
  return false;
}

export async function renderImageDetailLean({
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
  const id = Number(query.imageId);
  if (!Number.isInteger(id)) return { fallback: 'not-found' };

  const image = readQuery<ImageRow | null>(ssg, ssg.image.get.queryOptions({ id }).queryKey).data;
  // `ImageDetailProvider` / `ImageDetail2` answer NotFound; this file does not draw that page.
  if (!image) return { fallback: 'not-found' };
  if (isImageDetailPoiHidden(image, null)) return { fallback: 'not-found' };
  type HiddenData = Parameters<typeof expandHiddenPreferences>[0];
  const hiddenKey = ssg.hiddenPreferences.getHidden.queryOptions().queryKey;
  const hidden = expandHiddenPreferences(readQuery<HiddenData>(ssg, hiddenKey).data);
  if (hidden.blockedUsers.some((u) => u.id === image.user.id)) return { fallback: 'not-found' };
  // A contest's forced rating comes from details only a signed-in render prefetches.
  if (readQuery(ssg, ssg.image.getContestCollectionDetails.queryOptions({ id }).queryKey).found)
    return { fallback: 'unsupported' };

  const { state } = decideGatedState({
    contentNsfwLevel: imageDetailGateLevel(image, null),
    bypassRating: false,
    canViewNsfw: !!features.canViewNsfw,
    signedIn: false,
    sessionLoading: false,
    verifiedBot: false,
  });
  if (state !== 'page') return { fallback: 'gated' };

  const generationKey = ssg.image.getGenerationData.queryOptions({ id }).queryKey;
  const generation = readQuery<GenerationData>(ssg, generationKey).data;
  if (unsupported(image, generation)) return { fallback: 'unsupported' };

  const baseUrl = env.NEXT_PUBLIC_BASE_URL ?? '';
  const username = image.user.username;
  const title = `Image posted ${username ? `by ${username}` : 'to civitai'}`;
  const ogImage = ogImageUrl(`/api/og?type=image&id=${image.id}`);
  const domain = getRequestDomainColor(req);
  const siteSchema = getSiteSchema({
    domain: domain ?? undefined,
    serverDomains: {
      green: serverDomainMap.green,
      blue: serverDomainMap.blue,
      red: serverDomainMap.red,
    },
  });
  const mediaSchema = buildImageMediaSchema({ image, title, baseUrl: env.NEXT_PUBLIC_BASE_URL });
  const breadcrumb = buildBreadcrumbSchema(baseUrl, [
    { name: 'Images', path: '/images' },
    { name: title },
  ]);
  const jsonLd = (value: unknown) =>
    value ? `<script type="application/ld+json">${serializeJsonLd(value)}</script>` : '';

  const head =
    `<meta charset="utf-8"><meta name="viewport" content="${esc(VIEWPORT_META_CONTENT)}">` +
    jsonLd(siteSchema) +
    `<title>${esc(title)}</title>` +
    `<meta name="title"${attr('content', title)}>` +
    `<meta property="og:title"${attr('content', title)}>` +
    `<meta property="twitter:title"${attr('content', title)}>` +
    `<meta property="og:type" content="website">` +
    `<meta property="twitter:card" content="summary_large_image">` +
    `<meta property="og:image"${attr('content', ogImage)}>` +
    `<meta property="og:image:width" content="1200">` +
    `<meta property="og:image:height" content="630">` +
    `<meta property="twitter:image"${attr('content', ogImage)}>` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<link rel="canonical"${attr('href', resolveMetaHref(`/images/${image.id}`, baseUrl))}>` +
    jsonLd(mediaSchema) +
    jsonLd(breadcrumb);

  const controls = imageControls(image, image.url as string, features);
  const mainImage = `<img${attr('src', imageDetailMainImageUrl(image))}${attr('alt', image.name)}>`;

  const sidebar =
    controls +
    creatorCard(image) +
    (generation ? processCard(generation) : '') +
    (generation ? generationCard(generation) : '') +
    discussionCard(image.id);

  const body =
    `<main><div>${controls}</div><div>${mainImage}</div>${reactions(image)}</main>` +
    `<aside>${sidebar}</aside>`;

  return {
    html: `<!DOCTYPE html><html lang="en"><head>${head}</head><body>${body}</body></html>`,
  };
}
