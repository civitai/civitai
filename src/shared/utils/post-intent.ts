import * as z from 'zod';
import { POST_TAG_LIMIT } from '~/server/common/constants';
import { commaDelimitedStringArray } from '~/utils/zod-helpers';

export const POST_INTENT_MAX_MEDIA = 10;

const httpsUrl = z.url().refine((value) => value.startsWith('https://'), 'must be an https url');

const toArray = (value: unknown) =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];

export const openIntentQuerySchema = z
  .object({
    media: z.preprocess(toArray, z.array(z.url()).max(POST_INTENT_MAX_MEDIA).optional()),
    mediaUrl: z.url().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    detailsUrl: z.url().optional(),
    tags: commaDelimitedStringArray()
      .refine((tags) => tags.length <= POST_TAG_LIMIT, `Maximum of ${POST_TAG_LIMIT} tags`)
      .optional(),
    link: httpsUrl.optional(),
  })
  .transform(({ media, mediaUrl, ...rest }, ctx) => {
    const mediaUrls = [...new Set([...(mediaUrl ? [mediaUrl] : []), ...(media ?? [])])];
    if (mediaUrls.length === 0 || mediaUrls.length > POST_INTENT_MAX_MEDIA) {
      ctx.issues.push({
        code: 'custom',
        input: mediaUrls,
        path: ['media'],
        message: `Between 1 and ${POST_INTENT_MAX_MEDIA} media urls are required`,
      });
      return z.NEVER;
    }
    return { ...rest, mediaUrls };
  });
export type OpenIntentQuery = z.infer<typeof openIntentQuerySchema>;

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** The description with a "Source" link to `link` appended, as post detail HTML. */
export function appendSourceLink(description: string | undefined, link: string | undefined) {
  if (!link) return description;
  const href = escapeHtml(link);
  const source = `<p>Source: <a href="${href}" rel="ugc nofollow noopener" target="_blank">${href}</a></p>`;
  return description ? `${description}\n${source}` : source;
}

/** Plain text typed in the compose sheet, as post detail HTML: escaped, one paragraph per line. */
export function plainTextToPostHtml(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
}

export function withPostedParam(returnUrl: string, postId: number) {
  const url = new URL(returnUrl);
  url.searchParams.set('posted', String(postId));
  return url.toString();
}

export type IntentMode = { mode: 'app'; manifestUrl: string } | { mode: 'open' };

/** App mode needs both a `manifest` link and the app-mode flag; everything else is open mode. */
export function resolveIntentMode(
  query: Record<string, unknown>,
  appModeEnabled: boolean
): IntentMode {
  const manifest = query.manifest;
  if (appModeEnabled && typeof manifest === 'string' && manifest.startsWith('https://'))
    return { mode: 'app', manifestUrl: manifest };
  return { mode: 'open' };
}
