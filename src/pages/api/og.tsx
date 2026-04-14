import { ImageResponse } from 'next/og';
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { abbreviateNumber } from '~/utils/number-helpers';
import { removeTags } from '~/utils/string-helpers';

// --- Schema & Types ---

const querySchema = z.object({
  type: z.enum(['model', 'post', 'image', 'article', 'bounty', 'challenge']),
  id: z.coerce.number().int().positive(),
});

type StatItem = { value: string; label: string };

type OgImage = {
  url: string;
  nsfwLevel: number;
  type: MediaType;
  width: number | null;
  height: number | null;
};

type EntityData = {
  title: string;
  description: string;
  creator: string;
  imageUrl: string | null;
  imageAspectRatio: number;
  stats: StatItem[];
};

// --- Constants ---

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 630;
const IMAGE_WIDTH = 450;
const STATS_HEIGHT = 80;
const ACCENT_HEIGHT = 6;
const CONTENT_PADDING_Y = 100; // 60 top + 40 bottom
const IMAGE_HEIGHT = CANVAS_HEIGHT - STATS_HEIGHT - ACCENT_HEIGHT - CONTENT_PADDING_Y;

const colors = {
  bg: 'radial-gradient(ellipse at center, #25262B, #101113)',
  statsBg: '#141517', // dark-8
  border: '#373A40', // dark-4
  textPrimary: '#C1C2C5', // dark-0
  textSecondary: '#8c8fa3', // dark-2
  blue: '#228BE6', // blue-6
};

const ogImageSelect = {
  url: true,
  nsfwLevel: true,
  type: true,
  width: true,
  height: true,
} as const;

// --- Utilities ---

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trim() + '…';
}

function cleanDescription(html: string, max = 120): string {
  return truncate(removeTags(html), max);
}

function formatStat(n: number): string {
  return abbreviateNumber(n);
}

function getAspectRatio(img: { width?: number | null; height?: number | null }): number {
  if (img.width && img.height && img.height > 0) return img.width / img.height;
  return 1;
}

function getSafeImage(image: OgImage | null | undefined): OgImage | null {
  if (!image || !getIsSafeBrowsingLevel(image.nsfwLevel)) return null;
  return image;
}

function buildEntityImage(
  image: OgImage | null
): Pick<EntityData, 'imageUrl' | 'imageAspectRatio'> {
  if (!image) return { imageUrl: null, imageAspectRatio: 1 };
  return {
    imageUrl: getEdgeUrl(image.url, {
      width: IMAGE_WIDTH,
      height: IMAGE_HEIGHT,
      fit: 'cover',
      quality: 90,
      ...(image.type === 'video' ? { anim: false, transcode: true } : {}),
    }),
    imageAspectRatio: getAspectRatio(image),
  };
}

function sumReactions(metric: {
  heartCount: number;
  likeCount: number;
  laughCount: number;
  cryCount: number;
}): number {
  return metric.heartCount + metric.likeCount + metric.laughCount + metric.cryCount;
}

// --- Data fetchers ---

async function fetchModelData(id: number): Promise<EntityData | null> {
  const model = await dbRead.model.findFirst({
    where: { id, status: 'Published' },
    select: {
      name: true,
      description: true,
      user: { select: { username: true } },
      modelVersions: {
        where: { status: 'Published' },
        select: { id: true, description: true },
        orderBy: { index: 'asc' },
        take: 1,
      },
    },
  });
  if (!model) return null;

  const publishedVersion = model.modelVersions[0];
  if (!publishedVersion) return null;

  // Run metric + image queries in parallel
  const [metric, image] = await Promise.all([
    dbRead.modelMetric
      .findUnique({
        where: { modelId: id },
        select: {
          downloadCount: true,
          thumbsUpCount: true,
          commentCount: true,
          generationCount: true,
        },
      })
      .catch(() => null),
    dbRead.image.findFirst({
      where: {
        post: { publishedAt: { not: null }, modelVersionId: publishedVersion.id },
        tosViolation: false,
        needsReview: null,
        ingestion: 'Scanned',
      },
      select: ogImageSelect,
      orderBy: { index: 'asc' },
    }),
  ]);

  const stats: StatItem[] = metric
    ? [
        { value: formatStat(metric.downloadCount), label: 'Downloads' },
        { value: formatStat(metric.thumbsUpCount), label: 'Likes' },
        { value: formatStat(metric.generationCount), label: 'Generations' },
        { value: formatStat(metric.commentCount), label: 'Comments' },
      ]
    : [];

  const description = publishedVersion.description || model.description || '';

  return {
    title: model.name,
    description: cleanDescription(description),
    creator: model.user.username ?? 'Unknown',
    ...buildEntityImage(getSafeImage(image)),
    stats,
  };
}

async function fetchArticleData(id: number): Promise<EntityData | null> {
  const [article, metric] = await Promise.all([
    dbRead.article.findFirst({
      where: { id, publishedAt: { not: null }, tosViolation: false },
      select: {
        title: true,
        content: true,
        user: { select: { username: true } },
        coverImage: { select: ogImageSelect },
      },
    }),
    dbRead.articleMetric
      .findFirst({
        where: { articleId: id, timeframe: 'AllTime' },
        select: {
          viewCount: true,
          commentCount: true,
          collectedCount: true,
          tippedAmountCount: true,
        },
      })
      .catch(() => null),
  ]);
  if (!article) return null;

  const stats: StatItem[] = metric
    ? [
        { value: formatStat(metric.viewCount), label: 'Views' },
        { value: formatStat(metric.commentCount), label: 'Comments' },
        { value: formatStat(metric.collectedCount), label: 'Collected' },
        { value: formatStat(metric.tippedAmountCount), label: 'Tipped' },
      ]
    : [];

  return {
    title: article.title,
    description: cleanDescription(article.content ?? ''),
    creator: article.user.username ?? 'Unknown',
    ...buildEntityImage(getSafeImage(article.coverImage)),
    stats,
  };
}

async function fetchPostData(id: number): Promise<EntityData | null> {
  const post = await dbRead.post.findFirst({
    where: { id, publishedAt: { not: null } },
    select: {
      title: true,
      detail: true,
      user: { select: { username: true } },
      _count: { select: { images: true } },
    },
  });
  if (!post) return null;

  const [metric, image] = await Promise.all([
    dbRead.postMetric
      .findFirst({
        where: { postId: id, timeframe: 'AllTime' },
        select: {
          heartCount: true,
          likeCount: true,
          laughCount: true,
          cryCount: true,
          commentCount: true,
          collectedCount: true,
        },
      })
      .catch(() => null),
    dbRead.image.findFirst({
      where: {
        postId: id,
        post: { publishedAt: { not: null } },
        tosViolation: false,
        needsReview: null,
        ingestion: 'Scanned',
      },
      select: ogImageSelect,
      orderBy: { index: 'asc' },
    }),
  ]);

  const stats: StatItem[] = metric
    ? [
        { value: formatStat(sumReactions(metric)), label: 'Reactions' },
        { value: formatStat(metric.commentCount), label: 'Comments' },
        { value: formatStat(metric.collectedCount), label: 'Collected' },
        { value: String(post._count.images), label: 'Images' },
      ]
    : [{ value: String(post._count.images), label: 'Images' }];

  return {
    title: post.title || `Post by ${post.user.username}`,
    description: cleanDescription(post.detail ?? ''),
    creator: post.user.username ?? 'Unknown',
    ...buildEntityImage(getSafeImage(image)),
    stats,
  };
}

async function fetchImageData(id: number): Promise<EntityData | null> {
  const image = await dbRead.image.findFirst({
    where: { id, tosViolation: false, needsReview: null, ingestion: 'Scanned' },
    select: {
      ...ogImageSelect,
      user: { select: { username: true } },
      post: {
        select: {
          title: true,
          modelVersion: { select: { model: { select: { name: true } } } },
        },
      },
    },
  });
  if (!image) return null;

  const modelName = image.post?.modelVersion?.model?.name;
  const postTitle = image.post?.title;
  const title = postTitle || (modelName ? `Generated with ${modelName}` : 'Image on Civitai');

  // Only show the image if it's SFW; otherwise card renders with logo placeholder
  const safeImage = getSafeImage(image);

  let reactionCount = 0;
  let commentCount = 0;
  let collectedCount = 0;
  let viewCount = 0;
  try {
    const metric = await dbRead.imageMetric.findFirst({
      where: { imageId: id, timeframe: 'AllTime' },
      select: {
        heartCount: true,
        likeCount: true,
        laughCount: true,
        cryCount: true,
        commentCount: true,
        collectedCount: true,
        viewCount: true,
      },
    });
    if (metric) {
      reactionCount = sumReactions(metric);
      commentCount = metric.commentCount;
      collectedCount = metric.collectedCount;
      viewCount = metric.viewCount;
    }
  } catch {
    /* stats unavailable */
  }

  return {
    title,
    description: '',
    creator: image.user.username ?? 'Unknown',
    ...buildEntityImage(safeImage),
    stats: [
      { value: formatStat(reactionCount), label: 'Reactions' },
      { value: formatStat(commentCount), label: 'Comments' },
      { value: formatStat(collectedCount), label: 'Collected' },
      { value: formatStat(viewCount), label: 'Views' },
    ],
  };
}

async function fetchBountyData(id: number): Promise<EntityData | null> {
  const [bounty, metric, connection] = await Promise.all([
    dbRead.bounty.findFirst({
      where: { id },
      select: {
        name: true,
        description: true,
        user: { select: { username: true } },
      },
    }),
    dbRead.bountyMetric
      .findFirst({
        where: { bountyId: id, timeframe: 'AllTime' },
        select: {
          entryCount: true,
          favoriteCount: true,
          commentCount: true,
          unitAmountCount: true,
        },
      })
      .catch(() => null),
    dbRead.imageConnection.findFirst({
      where: {
        entityType: 'Bounty',
        entityId: id,
        image: { tosViolation: false, needsReview: null, ingestion: 'Scanned' },
      },
      select: { image: { select: ogImageSelect } },
    }),
  ]);
  if (!bounty) return null;

  const stats: StatItem[] = metric
    ? [
        { value: formatStat(metric.entryCount), label: 'Entries' },
        { value: formatStat(metric.favoriteCount), label: 'Favorites' },
        { value: formatStat(metric.commentCount), label: 'Comments' },
        ...(metric.unitAmountCount > 0
          ? [{ value: formatStat(metric.unitAmountCount), label: 'Buzz' }]
          : []),
      ]
    : [];

  return {
    title: bounty.name,
    description: cleanDescription(bounty.description ?? ''),
    creator: bounty.user?.username ?? 'Unknown',
    ...buildEntityImage(getSafeImage(connection?.image)),
    stats,
  };
}

async function fetchChallengeData(id: number): Promise<EntityData | null> {
  const challenge = await dbRead.challenge.findFirst({
    where: { id },
    select: {
      title: true,
      theme: true,
      invitation: true,
      description: true,
      coverImage: { select: ogImageSelect },
      prizePool: true,
      collection: { select: { _count: { select: { items: true } } } },
      winners: { select: { id: true } },
    },
  });
  if (!challenge) return null;

  const entryCount = challenge.collection?._count?.items ?? 0;
  const winnerCount = challenge.winners?.length ?? 0;

  const stats: StatItem[] = [
    { value: formatStat(entryCount), label: 'Entries' },
    ...(winnerCount > 0 ? [{ value: String(winnerCount), label: 'Winners' }] : []),
    ...(challenge.prizePool > 0
      ? [{ value: formatStat(challenge.prizePool), label: 'Buzz Prize' }]
      : []),
  ];

  return {
    title: challenge.title,
    description: cleanDescription(
      (challenge.invitation || challenge.theme || challenge.description) ?? ''
    ),
    creator: 'Civitai Challenge',
    ...buildEntityImage(getSafeImage(challenge.coverImage)),
    stats,
  };
}

const dataFetchers: Record<string, (id: number) => Promise<EntityData | null>> = {
  model: fetchModelData,
  post: fetchPostData,
  image: fetchImageData,
  article: fetchArticleData,
  bounty: fetchBountyData,
  challenge: fetchChallengeData,
};

// --- Layout components ---

function CoverImage({ url, aspectRatio }: { url: string; aspectRatio: number }) {
  const imgWidth =
    aspectRatio < 1 ? IMAGE_WIDTH : Math.max(IMAGE_WIDTH, Math.round(IMAGE_HEIGHT * aspectRatio));
  const imgHeight = aspectRatio < 1 ? Math.round(IMAGE_WIDTH / aspectRatio) : IMAGE_HEIGHT;

  return (
    <div
      style={{
        display: 'flex',
        width: IMAGE_WIDTH,
        height: IMAGE_HEIGHT,
        flexShrink: 0,
        borderRadius: 12,
        overflow: 'hidden',
        alignItems: 'flex-start',
        justifyContent: 'center',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} width={imgWidth} height={imgHeight} alt="" />
    </div>
  );
}

function LogoPlaceholder({ baseUrl }: { baseUrl: string }) {
  return (
    <div
      style={{
        display: 'flex',
        width: 200,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${baseUrl}/images/apple-touch-icon.png`}
        width={120}
        height={120}
        alt=""
        style={{ borderRadius: 24 }}
      />
    </div>
  );
}

function OgCard({ data }: { data: EntityData }) {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://civitai.com';
  const titleFontSize = data.title.length > 40 ? 40 : 48;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        background: colors.bg,
      }}
    >
      {/* Main content */}
      <div
        style={{
          display: 'flex',
          flexGrow: 1,
          paddingTop: 60,
          paddingRight: 64,
          paddingBottom: 40,
          paddingLeft: 64,
          gap: 40,
        }}
      >
        {/* Text column */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flexGrow: 1,
            flexShrink: 1,
            justifyContent: 'center',
            gap: 16,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              fontSize: titleFontSize,
              fontWeight: 700,
              color: colors.textPrimary,
              lineHeight: 1.1,
            }}
          >
            {truncate(data.title, 70)}
          </div>
          {data.description ? (
            <div
              style={{
                display: 'flex',
                fontSize: 22,
                color: colors.textSecondary,
                lineHeight: 1.4,
              }}
            >
              {data.description}
            </div>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', fontSize: 18, color: colors.textSecondary }}>by</div>
            <div
              style={{
                display: 'flex',
                fontSize: 18,
                fontWeight: 600,
                color: colors.textPrimary,
              }}
            >
              {data.creator}
            </div>
          </div>
        </div>

        {data.imageUrl ? (
          <CoverImage url={data.imageUrl} aspectRatio={data.imageAspectRatio} />
        ) : (
          <LogoPlaceholder baseUrl={baseUrl} />
        )}
      </div>

      {/* Stats bar */}
      <div
        style={{
          display: 'flex',
          height: STATS_HEIGHT,
          paddingLeft: 64,
          paddingRight: 64,
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: colors.statsBg,
          borderTop: `1px solid ${colors.border}`,
        }}
      >
        <div style={{ display: 'flex', gap: 40 }}>
          {data.stats.map((stat, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  display: 'flex',
                  fontSize: 18,
                  fontWeight: 600,
                  color: colors.textPrimary,
                }}
              >
                {stat.value}
              </div>
              <div style={{ display: 'flex', fontSize: 16, color: colors.textSecondary }}>
                {stat.label}
              </div>
            </div>
          ))}
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`${baseUrl}/images/apple-touch-icon.png`}
          width={36}
          height={36}
          alt=""
          style={{ borderRadius: 6 }}
        />
      </div>

      {/* Blue accent bar */}
      <div
        style={{
          display: 'flex',
          height: ACCENT_HEIGHT,
          backgroundColor: colors.blue,
          width: CANVAS_WIDTH,
        }}
      />
    </div>
  );
}

function FallbackCard() {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://civitai.com';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        background: colors.bg,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexGrow: 1,
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 20,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`${baseUrl}/images/logo_dark_mode.png`} height={60} alt="" />
        <div style={{ display: 'flex', fontSize: 16, color: colors.textSecondary }}>
          The Home of Open-Source Generative AI
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          height: ACCENT_HEIGHT,
          backgroundColor: colors.blue,
          width: CANVAS_WIDTH,
        }}
      />
    </div>
  );
}

// --- Main handler ---

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid parameters. Expected ?type=model&id=123' });
  }

  const { type, id } = parsed.data;

  try {
    const fetcher = dataFetchers[type];
    const data = await fetcher(id);

    const element = data ? <OgCard data={data} /> : <FallbackCard />;

    const imageResponse = new ImageResponse(element, {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
    });

    const buffer = Buffer.from(await imageResponse.arrayBuffer());

    res.setHeader('Content-Type', 'image/png');
    res.setHeader(
      'Cache-Control',
      'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400'
    );
    res.setHeader('CDN-Cache-Control', 'max-age=604800');
    res.send(buffer);
  } catch (error) {
    console.error('OG image generation failed:', error);

    try {
      const fallback = new ImageResponse(<FallbackCard />, {
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
      });
      const buffer = Buffer.from(await fallback.arrayBuffer());
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
      res.send(buffer);
    } catch {
      res.status(500).json({ error: 'Failed to generate OG image' });
    }
  }
}
