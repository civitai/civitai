import { ImageResponse } from 'next/og';
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import type { MediaType } from '~/shared/utils/prisma/enums';

const querySchema = z.object({
  type: z.enum(['model', 'post', 'image', 'article', 'bounty']),
  id: z.coerce.number().int().positive(),
});

type OgImage = {
  url: string;
  nsfwLevel: number;
  type: MediaType;
};

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 630;
const GAP = 4;
const BG_COLOR = '#111';

// --- Image fetchers per entity type ---

async function fetchModelImages(modelId: number): Promise<OgImage[]> {
  return dbRead.image.findMany({
    where: {
      post: {
        publishedAt: { not: null },
        modelVersion: { modelId, status: 'Published' },
      },
      tosViolation: false,
      needsReview: null,
      ingestion: 'Scanned',
    },
    select: { url: true, nsfwLevel: true, type: true },
    orderBy: [{ post: { modelVersion: { index: 'asc' } } }, { index: 'asc' }],
    take: 5,
  });
}

async function fetchPostImages(postId: number): Promise<OgImage[]> {
  return dbRead.image.findMany({
    where: {
      postId,
      post: { publishedAt: { not: null } },
      tosViolation: false,
      needsReview: null,
      ingestion: 'Scanned',
    },
    select: { url: true, nsfwLevel: true, type: true },
    orderBy: { index: 'asc' },
    take: 5,
  });
}

async function fetchSingleImage(imageId: number): Promise<OgImage[]> {
  const image = await dbRead.image.findFirst({
    where: {
      id: imageId,
      tosViolation: false,
      needsReview: null,
      ingestion: 'Scanned',
    },
    select: { url: true, nsfwLevel: true, type: true },
  });
  return image ? [image] : [];
}

async function fetchArticleImage(articleId: number): Promise<OgImage[]> {
  const article = await dbRead.article.findFirst({
    where: {
      id: articleId,
      publishedAt: { not: null },
      tosViolation: false,
    },
    select: {
      coverImage: { select: { url: true, nsfwLevel: true, type: true } },
    },
  });
  return article?.coverImage ? [article.coverImage] : [];
}

async function fetchBountyImages(bountyId: number): Promise<OgImage[]> {
  const connections = await dbRead.imageConnection.findMany({
    where: {
      entityType: 'Bounty',
      entityId: bountyId,
      image: { tosViolation: false, needsReview: null, ingestion: 'Scanned' },
    },
    select: {
      image: {
        select: { url: true, nsfwLevel: true, type: true },
      },
    },
    take: 5,
  });
  return connections.map((c) => c.image);
}

const imageFetchers: Record<string, (id: number) => Promise<OgImage[]>> = {
  model: fetchModelImages,
  post: fetchPostImages,
  image: fetchSingleImage,
  article: fetchArticleImage,
  bounty: fetchBountyImages,
};

// --- CDN URL construction ---

function buildOgImageUrl(src: string, width: number, height: number, type?: MediaType): string {
  const isVideo = type === 'video';
  return getEdgeUrl(src, {
    width,
    height,
    fit: 'cover',
    quality: 90,
    ...(isVideo ? { anim: false, transcode: true } : {}),
  });
}

// --- Layout components ---

function LogoBadge() {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://civitai.com';
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 24,
        left: 24,
        width: 40,
        height: 40,
        borderRadius: 10,
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`${baseUrl}/images/apple-touch-icon.png`} width={32} height={32} alt="Civitai" />
    </div>
  );
}

function BottomGradient() {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        width: CANVAS_WIDTH,
        height: 200,
        background: 'linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,0.5))',
      }}
    />
  );
}

function FallbackLayout() {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://civitai.com';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        background: 'radial-gradient(ellipse at center, #25262B, #101113)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 20,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`${baseUrl}/images/logo_dark_mode.png`} height={60} alt="Civitai" />
        <span style={{ fontSize: 16, color: '#8c8fa3' }}>
          The Home of Open-Source Generative AI
        </span>
      </div>
    </div>
  );
}

function CoverImage({ url, width, height }: { url: string; width: number; height: number }) {
  return (
    <div
      style={{
        width,
        height,
        overflow: 'hidden',
        display: 'flex',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} width={width} height={height} alt="" style={{ width, height }} />
    </div>
  );
}

function SingleImageLayout({ url }: { url: string }) {
  return (
    <div
      style={{
        display: 'flex',
        position: 'relative',
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        backgroundColor: BG_COLOR,
      }}
    >
      <CoverImage url={url} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} />
      <BottomGradient />
      <LogoBadge />
    </div>
  );
}

function TwoImageLayout({ urls }: { urls: [string, string] }) {
  const imgWidth = (CANVAS_WIDTH - GAP) / 2;
  return (
    <div
      style={{
        display: 'flex',
        position: 'relative',
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        backgroundColor: BG_COLOR,
        gap: GAP,
      }}
    >
      <CoverImage url={urls[0]} width={imgWidth} height={CANVAS_HEIGHT} />
      <CoverImage url={urls[1]} width={imgWidth} height={CANVAS_HEIGHT} />
      <BottomGradient />
      <LogoBadge />
    </div>
  );
}

function ThreeImageLayout({ urls }: { urls: [string, string, string] }) {
  const imgWidth = (CANVAS_WIDTH - GAP * 2) / 3;
  return (
    <div
      style={{
        display: 'flex',
        position: 'relative',
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        backgroundColor: BG_COLOR,
        gap: GAP,
      }}
    >
      <CoverImage url={urls[0]} width={imgWidth} height={CANVAS_HEIGHT} />
      <CoverImage url={urls[1]} width={imgWidth} height={CANVAS_HEIGHT} />
      <CoverImage url={urls[2]} width={imgWidth} height={CANVAS_HEIGHT} />
      <BottomGradient />
      <LogoBadge />
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
    const fetcher = imageFetchers[type];
    const rawImages = await fetcher(id);
    const sfwImages = rawImages.filter((img) => getIsSafeBrowsingLevel(img.nsfwLevel));
    const imageCount = Math.min(sfwImages.length, 3);

    let element: React.ReactElement;

    if (imageCount === 0) {
      element = <FallbackLayout />;
    } else if (imageCount === 1) {
      const url = buildOgImageUrl(sfwImages[0].url, CANVAS_WIDTH, CANVAS_HEIGHT, sfwImages[0].type);
      element = <SingleImageLayout url={url} />;
    } else if (imageCount === 2) {
      const imgWidth = Math.round((CANVAS_WIDTH - GAP) / 2);
      const urls = sfwImages
        .slice(0, 2)
        .map((img) => buildOgImageUrl(img.url, imgWidth, CANVAS_HEIGHT, img.type)) as [
        string,
        string
      ];
      element = <TwoImageLayout urls={urls} />;
    } else {
      const imgWidth = Math.round((CANVAS_WIDTH - GAP * 2) / 3);
      const urls: [string, string, string] = [
        buildOgImageUrl(sfwImages[0].url, imgWidth, CANVAS_HEIGHT, sfwImages[0].type),
        buildOgImageUrl(sfwImages[1].url, imgWidth, CANVAS_HEIGHT, sfwImages[1].type),
        buildOgImageUrl(sfwImages[2].url, imgWidth, CANVAS_HEIGHT, sfwImages[2].type),
      ];
      element = <ThreeImageLayout urls={urls} />;
    }

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

    // Return fallback on any error
    try {
      const fallback = new ImageResponse(<FallbackLayout />, {
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
