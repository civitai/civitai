import { constants } from '~/server/common/constants';
import type { RemixAppDefinition } from '~/shared/constants/remix-apps.constants';
import { DEFAULT_ENGINE } from '~/shared/constants/remix-apps.constants';
import { getRemixTier, type RemixSourceImage } from '~/shared/utils/remix-tier';

export type ArticleReframeTarget = 'banner' | 'cover';

export const ARTICLE_REFRAME_TAG = 'article-reframe';

type ReframeSpec = {
  /** Run as a one-shot remix: `params.aspectRatio` is asked of the engine, which snaps it to a shape it supports. */
  app: RemixAppDefinition;
  /** width / height of the kept image. */
  keepAspect: number;
  /** The suggested width; a narrower take is kept but looks soft. */
  targetWidth: number;
};

const reframeApp = (
  target: ArticleReframeTarget,
  app: Pick<RemixAppDefinition, 'name' | 'engine' | 'prompt'> & {
    aspectRatio: RemixAppDefinition['params']['aspectRatio'];
  }
): RemixAppDefinition => ({
  slug: `${ARTICLE_REFRAME_TAG}-${target}`,
  icon: 'photo',
  output: 'image',
  name: app.name,
  engine: app.engine,
  prompt: app.prompt,
  params: { aspectRatio: app.aspectRatio, quantity: 1 },
});

/**
 * The mature engine (Qwen edit) tops out at 3:2, so a 4:1 crop of it is about 1216x304, half the
 * banner's width. Mature sources get a cover only.
 */
export const ARTICLE_REFRAME: Record<ArticleReframeTarget, ReframeSpec> = {
  banner: {
    keepAspect: constants.article.bannerImageWidth / constants.article.bannerImageHeight,
    targetWidth: constants.article.bannerImageWidth,
    app: reframeApp('banner', {
      name: 'Banner generation',
      aspectRatio: '21:9',
      engine: { safe: DEFAULT_ENGINE.safe },
      prompt:
        'Recompose this image as a wide panoramic banner. Keep the main subject, the art style, the colors and the mood the same. Extend the scene naturally to the left and right, and keep the main subject near the vertical center so it stays in frame when the top and bottom are trimmed. Do not add any text or lettering.',
    }),
  },
  cover: {
    keepAspect: constants.article.coverImageWidth / constants.article.coverImageHeight,
    targetWidth: constants.article.coverImageWidth,
    app: reframeApp('cover', {
      name: 'Cover generation',
      aspectRatio: '16:9',
      engine: DEFAULT_ENGINE,
      prompt:
        'Recompose this wide image as a landscape card image. Keep the main subject, the art style, the colors and the mood the same, with the main subject centered and fully in frame. Do not add any text or lettering.',
    }),
  },
};

export const MATURE_BANNER_REFUSAL = "Banner generation isn't available for mature images yet.";
export const UNRATED_BANNER_REFUSAL =
  'Banner generation is available once this image has been checked.';

/** Why this source cannot be reframed to `target`, before any engine rule; undefined if it can. */
export function getReframeRefusal(
  target: ArticleReframeTarget,
  source: { nsfwLevel?: number | null }
) {
  if (target !== 'banner') return undefined;
  // A form value may carry no rating; it is not shown as safe before the server has checked it.
  if (source.nsfwLevel == null) return UNRATED_BANNER_REFUSAL;
  if (getRemixTier({ nsfwLevel: source.nsfwLevel } as RemixSourceImage) === 'mature')
    return MATURE_BANNER_REFUSAL;
  return undefined;
}

/** The largest centred box of `aspect` (width / height) inside a `width` x `height` image. */
export function centreCropBox(width: number, height: number, aspect: number) {
  if (width <= 0 || height <= 0 || aspect <= 0) throw new Error('Invalid crop dimensions');
  const cropWidth = Math.min(width, Math.round(height * aspect));
  const cropHeight = Math.min(height, Math.round(cropWidth / aspect));
  return {
    left: Math.floor((width - cropWidth) / 2),
    top: Math.floor((height - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
  };
}
