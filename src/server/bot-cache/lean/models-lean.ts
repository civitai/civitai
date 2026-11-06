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
import { hiddenPreferencesState } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { filterPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { serializeJsonLd } from '@civitai/shared/json-ld';
import { getDisplayName, getInitials, removeTags, slugit } from '~/utils/string-helpers';
import { getImageProps } from 'next/image';
import dayjs from '~/shared/utils/dayjs';
import { residencyLabel } from '~/components/ResourceLoad/ResourceResidency';
import { howToUseModelHref } from '~/components/Model/HowToUseModel/HowToUseModel';
import {
  creatorCardStatsDefaults,
  getDisplayedBaseModelLicense,
  hasAdditionalLicensePermissions,
  constants,
} from '~/server/common/constants';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { getPrimaryFile, groupFilesByVariant, resolveActiveFile } from '~/server/utils/model-helpers';
import { getEcosystemSeoPageForKey } from '~/shared/constants/ecosystem-seo.constants';
import { getBaseModelGroup } from '~/shared/constants/basemodel.constants';
import { generatorReadiness } from '~/shared/generation/generator-readiness';
import { inferTensorMetadataFormat } from '~/utils/model-tensor-metadata';
import { getFileDescription, getFileLabel } from '~/utils/file-display-helpers';
import { abbreviateNumber, formatKBytes, numberWithCommas } from '~/utils/number-helpers';
import { formatDate } from '~/utils/date-helpers';
import { getRatingLabel } from '~/utils/rating-label';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';

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

type CarouselImage = {
  id: number;
  url: string;
  nsfwLevel: number;
  name?: string | null;
  width?: number | null;
  poi?: boolean;
  user: { id: number };
  stats?: Record<string, number | boolean | undefined> | null;
};

type CarouselFilters = {
  browsingLevel: number;
  excludedTagIds?: number[];
  disablePoi?: boolean;
  disableMinor?: boolean;
};

/**
 * The carousel's `image.getInfinite` prefetch (one per render) as `useQueryImages` shows it: its
 * items, de-duplicated, through the hidden-preference filter (`filterPreferences`) with the addon
 * filters the prefetch was keyed with — the client query's own key, so the same values. `null`
 * when it has no data (the carousel then shows a loader, which this file does not draw).
 */
function carouselImages(ssg: Ssg, hidden: ExpandedHidden): CarouselImage[] | null {
  const [query] = ssg.queryClient.getQueryCache().findAll({ queryKey: [['image', 'getInfinite']] });
  if (!query || query.state.status !== 'success') return null;
  const filters = (query.queryKey[1] as { input?: CarouselFilters } | undefined)?.input;
  if (!filters) return null;
  const data = query.state.data as { pages?: { items?: CarouselImage[] }[] } | undefined;
  const seen = new Set<number>();
  const items = (data?.pages ?? [])
    .flatMap((page) => page.items ?? [])
    .filter((item) => !seen.has(item.id) && !!seen.add(item.id));
  const { items: shown } = filterPreferences({
    type: 'images',
    data: items as never,
    hiddenPreferences: hiddenPreferencesState(hidden, {
      isModerator: false,
      disableHidden: false,
      excludedTagIds: filters.excludedTagIds,
      isLoading: false,
    }),
    browsingLevel: filters.browsingLevel,
    currentUser: null,
    canViewNsfw: false,
    poiDisabled: !!filters.disablePoi,
    minorDisabled: !!filters.disableMinor,
  });
  return shown as unknown as CarouselImage[];
}

type File = Version['files'][number];
type Creator = {
  id: number;
  username: string | null;
  image: string | null;
  deletedAt: Date | null;
  createdAt?: Date | null;
  links?: { url: string; type: string }[];
  stats?: Record<string, number | null> | null;
  rank?: { leaderboardRank: number | null; leaderboardId: string; leaderboardTitle: string } | null;
  publicSettings?: unknown;
  cosmetics?: unknown[];
  profilePicture?: unknown;
};

/** The model and version file sections this file draws: SafeTensor model files only. */
function modelFiles(model: Model, version: Version) {
  const visible = (version.files ?? []).filter((file) => file.visibility === 'Public');
  const grouped = groupFilesByVariant(visible, model.type);
  return { visible, grouped };
}

/** Whether the page is one this file does not draw, so the full render must answer. */
function unsupported(model: Model, version: Version, versions: Version[], ctx: UnsupportedCtx) {
  const row = model as unknown as {
    poi?: boolean;
    mode?: string | null;
    meta?: { showcaseCollectionId?: number } | null;
    licenses?: unknown[];
    reportStats?: { ownershipProcessing?: number } | null;
    user: { cosmetics?: unknown[]; profilePicture?: unknown };
  };
  if (row.poi || row.mode || row.licenses?.length) return true;
  if (row.reportStats?.ownershipProcessing) return true;
  if (row.user.cosmetics?.length || row.user.profilePicture) return true;
  if (ctx.showcase) return true;
  if (!ctx.creator || ctx.creator.cosmetics?.length || ctx.creator.profilePicture) return true;
  if (!ctx.hasAccess) return true;
  const earlyOrFlagged = versions.some((candidate) => {
    const v = candidate as unknown as {
      earlyAccessDeadline?: Date | null;
      paidAccess?: unknown;
      inaccurate?: boolean;
    };
    return !!v.earlyAccessDeadline || !!v.paidAccess || !!v.inaccurate;
  });
  if (earlyOrFlagged) return true;
  const v = version as unknown as {
    usageControl?: string | null;
    trainingStatus?: unknown;
    recommendedResources?: unknown[];
    linkedComponents?: unknown[];
    licensingFee?: number | null;
  };
  if (v.usageControl !== 'Download' || v.trainingStatus) return true;
  if (v.recommendedResources?.length || v.linkedComponents?.length || v.licensingFee) return true;
  const { visible, grouped } = modelFiles(model, version);
  if (!grouped.safeTensorVariants.length) return true;
  if (grouped.ggufVariants.length || grouped.otherFormatVariants.length) return true;
  if (Object.keys(grouped.requiredComponents).length || grouped.optionalFiles.length) return true;
  // `ModelFileAlert` warns about scans and negative/config files; not drawn here.
  return visible.some(
    (file) =>
      file.type !== 'Model' ||
      file.pickleScanResult !== 'Success' ||
      file.virusScanResult !== 'Success'
  );
}

type ExpandedHidden = ReturnType<typeof expandHiddenPreferences>;

type UnsupportedCtx = { showcase: unknown; creator: Creator | null; hasAccess: boolean };

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

  // The page reads `?modelVersionId=`, falling back to the first published version.
  const requested = Number(query.modelVersionId);
  const selected = versions.find((version) => version.id === requested) ?? versions[0]!;
  const showcaseKey = ssg.model.getCollectionShowcase.queryOptions({ id }).queryKey;
  const creatorKey = ssg.user.getCreator.queryOptions({ id: model.user.id }).queryKey;
  const accessInput = { entityId: [selected.id], entityType: 'ModelVersion' as const };
  const accessKey = ssg.common.getEntityAccess.queryOptions(accessInput).queryKey;
  const access = readQuery<{ hasAccess?: boolean }[]>(ssg, accessKey).data;
  const creator = readQuery<Creator>(ssg, creatorKey).data ?? null;
  const ctx = {
    showcase: readQuery(ssg, showcaseKey).data,
    creator,
    hasAccess: !!access?.[0]?.hasAccess,
  };
  if (unsupported(model, selected, versions, ctx) || !creator) return { fallback: 'unsupported' };
  const images = carouselImages(ssg, hidden);
  if (!images) return { fallback: 'unsupported' };
  // A description with markup `RenderHtml` rewrites (links, mentions, media, embeds, styles).
  const html = [model.description, selected.description].join('');
  if (/<(a|img|iframe|edge-media|time|span|div)\b|style=/i.test(html)) return { fallback: 'unsupported' };

  return { html: renderPage({ req, model, selected, versions, images, creator, features }) };
}

type PageArgs = {
  req: IncomingMessage;
  model: Model;
  selected: Version;
  versions: Version[];
  images: CarouselImage[];
  creator: Creator;
  features: FeatureAccess;
};

/** `AnimatedCount` → `CustomNumberFlow`: the formatted value, then one aria-hidden column per character. */
const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const fullFormatter = new Intl.NumberFormat('en-US');
const DIGIT_STACK_TEXT = '0\n1\n2\n3\n4\n5\n6\n7\n8\n9';
function count(value: number, abbreviate = true) {
  const formatted = (abbreviate ? compactFormatter : fullFormatter).format(value);
  const columns = [...formatted]
    .map((char) => (/^[0-9]$/.test(char) ? DIGIT_STACK_TEXT : esc(char)))
    .map((column) => `<span aria-hidden="true">${column}</span>`)
    .join('');
  return `<span><span>${esc(formatted)}</span>${columns}</span>`;
}

const p = (text: unknown) => `<p>${esc(text)}</p>`;
const link = (href: string, inner: string, rel?: string) =>
  `<a href="${esc(href)}"${attr('rel', rel)}>${inner}</a>`;

/** The site header for a signed-out visitor (`AppHeader`). */
function siteHeader(asPath: string) {
  const nav: [string, string][] = [
    ['/', 'home'],
    ['/models', 'models'],
    ['/images', 'images'],
    ['/videos', 'videos'],
    ['/articles', 'articles'],
    ['/changelog', 'updates'],
    ['/shop', 'shop'],
  ];
  return (
    '<header>' +
    link('/pricing?utm_campaign=support_pro', p('Pro')) +
    p('Create') +
    link(`/login?returnUrl=${asPath}`, p('Sign In'), 'nofollow') +
    p('Create') +
    nav.map(([href, label]) => link(href, p(label))).join('') +
    p('More') +
    '</header>'
  );
}

/** The site footer (`AppFooter`). */
function siteFooter() {
  const social = ['discord', 'twitter', 'instagram', 'youtube', 'tiktok', 'reddit', 'github', 'twitch'];
  const links: [string, string, string?][] = [
    ['/content/tos', 'Terms of Service'],
    ['/content/privacy', 'Privacy'],
    ['/safety', 'Safety'],
    ['https://developer.civitai.com/', 'API', 'nofollow'],
    ['https://status.civitai.com', 'Status', 'nofollow'],
    ['/issues', 'Known Issues'],
    ['/creator-program', 'Creators'],
    ['https://advertising.civitai.com', 'Advertise', 'nofollow'],
  ];
  return (
    '<footer>' +
    p(`© Civitai ${new Date().getFullYear()}`) +
    links.map(([href, label, rel]) => link(href, p(label), rel)).join('') +
    p('🛟 Support') +
    social.map((name) => link(`/${name}`, '', 'nofollow')).join('') +
    '</footer>'
  );
}

/** The title row, stat badges, updated date, category and tags, and the version list. */
function pageHeader({ model, versions, features }: PageArgs) {
  const rank = model.rank;
  const hiddenMetrics = (model as { hiddenMetrics?: Record<string, boolean> | null }).hiddenMetrics;
  const generating = versions.find((version) => version.canGenerate);
  const buzz =
    (rank?.tippedAmountCountAllTime ?? 0) +
    model.modelVersions.reduce((acc, version) => acc + (version.rank?.earnedAmountAllTime ?? 0), 0);
  const stats = [
    p(abbreviateNumber(rank?.thumbsUpCountAllTime ?? 0)),
    hiddenMetrics?.downloads ? '' : p(abbreviateNumber(rank?.downloadCountAllTime ?? 0)),
    generating && !hiddenMetrics?.generations
      ? p(abbreviateNumber(rank?.generationCountAllTime ?? 0))
      : '',
    features.collections ? p(abbreviateNumber(rank?.collectedCountAllTime ?? 0)) : '',
    !hiddenMetrics?.buzz ? p(abbreviateNumber(buzz)) : '',
  ].join('');
  // The page's own "What is this?" link, fixed.
  const howTo = 'https://education.civitai.com/civitais-guide-to-resource-types/#models';
  const tagHref = (name: string) => `/tag/${encodeURIComponent(name.toLowerCase())}`;
  const category = model.tagsOnModels.find(({ tag }) => !!tag.isCategory)?.tag;
  const tags = model.tagsOnModels.filter(({ tag }) => !tag.isCategory).map(({ tag }) => tag);
  const TAG_LIMIT = 5;
  const tagLinks = tags
    .slice(0, TAG_LIMIT)
    .map((tag) => link(tagHref(tag.name), p(tag.name)))
    .join('');
  const moreTags = tags.length > TAG_LIMIT ? `<button>+ ${tags.length - TAG_LIMIT}</button>` : '';
  return (
    `<h1>${esc(model.name)}</h1>` +
    stats +
    link(howTo, '', 'nofollow noreferrer') +
    p(`Updated: ${formatDate(model.updatedAt)}`) +
    (category ? link(tagHref(category.name), p(category.name)) : '') +
    tagLinks +
    moreTags +
    versions.map((version) => `<button>${esc(version.name)}</button>`).join('')
  );
}

/** `DownloadVariantDropdown`'s `VerifiedText` for a scanned-clean file. */
function verified(file: File) {
  const scanned = file.scannedAt ? dayjs(file.scannedAt).fromNow() : 'Scan requested';
  return `<p>Verified:</p><a><abbr>${esc(scanned)}</abbr></a>`;
}

/** The download card (`ModelVersionDetails` → `DownloadVariantDropdown`), SafeTensor files only. */
function downloadCard({ model, selected }: PageArgs) {
  const { grouped } = modelFiles(model, selected);
  const files = grouped.safeTensorVariants;
  const best = getPrimaryFile(files, { metadata: undefined });
  const active = resolveActiveFile(files, null, { metadata: undefined }) ?? files[0]!;
  const url = (file: File) =>
    createModelFileDownloadUrl({
      versionId: selected.id,
      fileId: file.id,
      type: file.type,
      meta: file.metadata,
    });
  const header = p('Download') + p(`${files.length} variant${files.length !== 1 ? 's' : ''} available`);
  const summary = (file: File, bestMatch: boolean) => {
    const label = getFileLabel(file);
    const description = getFileDescription(file);
    const title = [label, file.metadata?.format].filter(Boolean).join(' ') || file.name;
    const detail = [description, formatKBytes(file.sizeKB)].filter(Boolean).join(' • ');
    return (
      p(title) +
      (bestMatch ? p('Best match') : '') +
      (label ? p(file.name) : '') +
      p(detail) +
      verified(file)
    );
  };
  if (files.length === 1)
    return (
      header +
      summary(active, false) +
      link(url(active), `<p>Download (${esc(formatKBytes(active.sizeKB))})</p>`)
    );
  const row = (file: File) => {
    const label = getFileLabel(file);
    const description = getFileDescription(file);
    return (
      p(label ?? file.name) +
      (file.id === best?.id ? p('Best match') : '') +
      (label ? p(file.name) : '') +
      (description ? p(description) : '') +
      verified(file) +
      p(formatKBytes(file.sizeKB)) +
      link(url(file), '')
    );
  };
  return (
    header +
    summary(active, active.id === best?.id) +
    p('SafeTensor') +
    files.map(row).join('') +
    link(url(active), p('Download Selected'))
  );
}

/** The "Details" accordion, "Tensors", and "About this version". */
function versionDetails({ model, selected, features }: PageArgs) {
  const rank = selected.rank;
  const hidden = (selected as { hiddenMetrics?: Record<string, boolean> | null }).hiddenMetrics;
  const canGenerate = !!features.imageGeneration && !!selected.canGenerate;
  const earned = rank?.earnedAmountAllTime ?? 0;
  const howTo = howToUseModelHref(model.type);
  const typeRow =
    p('Type') +
    p(`${getDisplayName(model.type)} ${model.checkpointType ?? ''}`) +
    (howTo ? link(howTo, '', 'nofollow noreferrer') : '');
  const statsRow =
    p('Stats') +
    (hidden?.downloads ? '' : count(rank?.downloadCountAllTime ?? 0, false)) +
    (canGenerate && !hidden?.generations ? count(rank?.generationCountAllTime ?? 0) : '') +
    (earned && !hidden?.buzz ? count(earned) : '');
  const up = rank?.thumbsUpCountAllTime ?? 0;
  const total = up + (rank?.thumbsDownCountAllTime ?? 0);
  const reviews = total
    ? link(
        `/models/${model.id}/reviews?modelVersionId=${selected.id}`,
        p(getRatingLabel({ positiveRating: up / total, totalCount: total }).label)
      ) + p(`(${numberWithCommas(total)})`)
    : p('No reviews yet');
  const published = selected.status === 'Published' && selected.publishedAt;
  const ecosystem = getEcosystemSeoPageForKey(getBaseModelGroup(selected.baseModel));
  const baseType =
    selected.baseModelType && selected.baseModelType !== 'Standard' ? ` ${selected.baseModelType}` : '';
  const baseModel = ecosystem
    ? link(`/ecosystems/${ecosystem.slug}`, esc(selected.baseModel)) + esc(baseType)
    : esc(`${selected.baseModel}${baseType}`);
  const training =
    selected.steps || selected.epochs
      ? p('Training') +
        (selected.steps ? p(`Steps: ${selected.steps.toLocaleString()}`) : '') +
        (selected.epochs ? p(`Epochs: ${selected.epochs.toLocaleString()}`) : '')
      : '';
  const strength = (selected.settings as { strength?: number } | null | undefined)?.strength;
  const hasClipSkip = selected.clipSkip !== null && selected.clipSkip !== undefined;
  const tips =
    hasClipSkip || strength !== undefined
      ? p('Usage Tips') +
        (hasClipSkip ? p(`Clip Skip: ${selected.clipSkip}`) : '') +
        (strength !== undefined ? p(`Strength: ${strength}`) : '')
      : '';
  const { grouped } = modelFiles(model, selected);
  const files = grouped.safeTensorVariants;
  const active = resolveActiveFile(files, null, { metadata: undefined }) ?? files[0];
  const hashes = active?.hashes ?? [];
  const hash = hashes.find((h) => h.type === 'AutoV2') ?? hashes[0];
  const hashRow = hash ? p('Hash') + p(hash.type) + p(hash.hash) : '';
  const words = selected.trainedWords ?? [];
  const WORD_LIMIT = 10;
  const wordsRow = words.length
    ? p('Trigger Words') +
      words
        .slice(0, WORD_LIMIT)
        .map((word) => p(word))
        .join('') +
      (words.length > WORD_LIMIT ? p(`+${words.length - WORD_LIMIT} more`) : '')
    : '';
  const tensors = files.some((file) => inferTensorMetadataFormat(file)) ? p('Tensors') : '';
  const description = selected.description
    ? p('About this version') +
      sanitizeHtml(selected.description) +
      (removeTags(selected.description).length > 150 ? p('Show more') : '')
    : '';
  return (
    p('Details') +
    typeRow +
    statsRow +
    p('Reviews') +
    reviews +
    p(published ? 'Published' : 'Uploaded') +
    p(formatDate(published ? selected.publishedAt : selected.createdAt)) +
    p('Base Model') +
    `<p>${baseModel}</p>` +
    training +
    tips +
    hashRow +
    wordsRow +
    tensors +
    description
  );
}

const BADGE_IMAGE = getImageProps({ src: '/images/base-badge.png', alt: '', width: 32, height: 32 })
  .props;

/** `SmartCreatorCard` → `CreatorCardSimple`, with the `user.getCreator` prefetch. */
function creatorCard(creator: Creator) {
  const rank = creator.rank;
  const rankBadge =
    rank?.leaderboardRank && rank.leaderboardRank <= 100
      ? link(`/leaderboard/${rank.leaderboardId}#${rank.leaderboardRank}`, p(`#${rank.leaderboardRank}`))
      : '';
  const settings = (creator.publicSettings ?? {}) as { creatorCardStatsPreferences?: string[] };
  const display = new Set(settings.creatorCardStatsPreferences ?? creatorCardStatsDefaults);
  const stats = creator.stats ?? {};
  const values: [string, number | null | undefined][] = [
    ['uploads', stats.uploadCountAllTime],
    ['reactions', stats.reactionCountAllTime],
    ['followers', stats.followerCountAllTime],
    ['likes', stats.thumbsUpCountAllTime],
    ['downloads', stats.downloadCountAllTime],
    ['generations', stats.generationCountAllTime],
  ];
  const badge =
    `<img src="${esc(BADGE_IMAGE.src)}" alt="" width="32" height="32"` +
    `${attr('srcset', BADGE_IMAGE.srcSet)}>`;
  const statBadges = creator.stats
    ? values
        .filter(([key, value]) => display.has(key) && value !== null && value !== undefined)
        .map(([, value]) => badge + count(value ?? 0))
        .join('')
    : '';
  const username = creator.username && !creator.deletedAt ? creator.username : null;
  const avatar = creator.image
    ? `<img src="${esc(getEdgeUrl(creator.image, { width: 96, optimized: true }))}"` +
      `${attr('alt', username ? `${username}'s Avatar` : undefined)} loading="lazy">`
    : p(username ? getInitials(username) : '');
  const joined = creator.createdAt ? p(`Joined ${formatDate(creator.createdAt)}`) : '';
  const inner = avatar + p(username ?? '[deleted]') + joined;
  const profile = username ? new URL(`/user/${username}`, 'http://n').pathname : null;
  const socials = (creator.links ?? [])
    .map((social) => link(social.url, '', 'nofollow noreferrer'))
    .join('');
  return (
    '<img src="/images/civitai-default-account-bg.png" alt="default creator card background decoration">' +
    rankBadge +
    statBadges +
    (profile ? link(profile, inner) : inner) +
    '<button>Follow</button>' +
    socials
  );
}

/**
 * `ModelCarousel`: only the first slide is in view on the server, so only its image is drawn — a
 * link to the image, the preview, and its reactions (`Reactions`, not read-only: the reactions
 * with a count, then the Buzz tip count, shown even at zero).
 */
function carousel(images: CarouselImage[]) {
  const [image] = images;
  if (!image) return '';
  const src = getEdgeUrl(image.url, { width: 800, name: image.name ?? undefined });
  const preview = `<img src="${esc(src)}"${attr('alt', image.name ?? undefined)}>`;
  const stats = image.stats ?? {};
  const emoji = constants.availableReactions as Record<string, string>;
  const metrics: Record<string, number> = {
    Like: Number(stats.likeCountAllTime ?? 0),
    Heart: Number(stats.heartCountAllTime ?? 0),
    Laugh: Number(stats.laughCountAllTime ?? 0),
    Cry: Number(stats.cryCountAllTime ?? 0),
  };
  const badges = (Object.keys(constants.availableReactions) as string[])
    .filter((key) => key in metrics && metrics[key]! >= 1)
    .map((key) => `<button>${p(emoji[key])} ${count(metrics[key]!, false)}</button>`)
    .join('');
  const tip = image.poi ? '' : `<span>${count(0)}</span>`;
  return link(`/images/${image.id}`, preview) + `<div>${badges}${tip}</div>`;
}

/** The license block under the creator card. */
function licenseBlock({ model, selected }: PageArgs) {
  const license = getDisplayedBaseModelLicense(selected.baseModel);
  if (model.type !== 'Checkpoint' && !license) return '';
  const addendum =
    (constants.supportedBaseModelAddendums as readonly string[]).includes(selected.baseModel) &&
    hasAdditionalLicensePermissions(model)
      ? link(`/models/license/${selected.id}`, p('Addendum'))
      : '';
  const lines = (license?.lines ?? [])
    .map(
      (line) =>
        (line.label ? p(line.label) : '') +
        (line.url ? link(line.url, p(line.name), 'nofollow noreferrer') : p(line.name)) +
        (line.suffix ? p(line.suffix) : '')
    )
    .join('');
  return (
    p('License:') +
    lines +
    addendum +
    (license?.notice ? p(license.notice) : '') +
    (license?.poweredBy ? p(license.poweredBy) : '')
  );
}

function renderPage(args: PageArgs) {
  const { req, model, selected, images, creator, features } = args;
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
  const categoryCrumb = category
    ? [{ name: category.name, path: `/tag/${encodeURIComponent(category.name)}` }]
    : [];
  const breadcrumb = buildBreadcrumbSchema(baseUrl, [
    { name: 'Models', path: '/models' },
    ...categoryCrumb,
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
  const canonical = resolveMetaHref(`/models/${model.id}/${slug}`, baseUrl);

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
    `<link rel="canonical"${attr('href', canonical)}>` +
    `<link rel="alternate"${attr('href', resolveMetaHref(`/models/${model.id}`, baseUrl))}>` +
    jsonLd(schema) +
    jsonLd(breadcrumb);

  const canGenerate = !!features.imageGeneration && !!selected.canGenerate;
  const generate = canGenerate
    ? p('Create') + p(residencyLabel(generatorReadiness(selected)))
    : '';
  const asPath = req.url ?? `/models/${model.id}/${slug}`;
  const body =
    siteHeader(asPath) +
    '<main>' +
    pageHeader(args) +
    generate +
    downloadCard(args) +
    versionDetails(args) +
    creatorCard(creator) +
    licenseBlock(args) +
    (model.mode !== 'TakenDown' ? carousel(images) : '') +
    (model.description ? sanitizeHtml(model.description) : '') +
    '</main>' +
    siteFooter();
  return `<!DOCTYPE html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
}
