import * as z from 'zod';

// Literals of the data.civitai.com Comments write path. They change only together with the
// platform; nothing else in the app spells them.
export const PLATFORM_COMMENT_PATH = '/internal/comment';
export const PLATFORM_SITE_VERDICT_PATH = '/internal/verdict/site';
export const PLATFORM_MOD_VERDICT_PATH = '/internal/verdict/mod';
export const PLATFORM_AUTHOR_ERASE_PATH = '/internal/author/erase';
export const PLATFORM_COMMENTS_READ_PATH = '/internal/comments';
export const PLATFORM_FEATURE_PAGES_APP = 'feature-pages';
export const PLATFORM_COMMENTS_PAGE_LIMIT = 500;

/** Refusal codes the platform answers that are final for the record they name. */
export const PlatformRefusal = {
  UnknownSubject: 'unknown_subject',
  Removed: 'removed',
  NotAuthor: 'not_author',
  IdempotencyMismatch: 'idempotency_mismatch',
  /** The author was erased: final for every comment of theirs. */
  Erased: 'erased',
} as const;
/** A missing route, which is a deploy gap and is retried, never a refusal. */
export const PLATFORM_ROUTE_MISSING = 'not_found';
/** A verdict named an older digest; `details.digest` is the current one. Retried with that digest. */
export const PLATFORM_STALE_DIGEST = 'stale_digest';

export const platformRefusalSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  details: z.record(z.string(), z.unknown()).nullish(),
});

export const commentPostReplySchema = z.object({
  ok: z.literal(true),
  urn: z.string().min(1),
  digest: z.string().min(1),
  retracted: z.boolean().optional(),
  /** The platform already holds a newer post of this comment; this body was not applied. */
  stale: z.boolean().optional(),
  /** Nothing changed, so nothing (no site verdict either) was written. */
  unchanged: z.boolean().optional(),
  /** The site verdict written for the new version: a held comment's may differ from the one sent. */
  verdict: z.object({ outcome: z.string() }).passthrough().optional(),
});

export const commentsPageSchema = z.object({
  items: z.array(
    z.object({
      urn: z.string(),
      digest: z.string().nullish(),
      retracted: z.boolean().optional(),
      removed: z.boolean().optional(),
      verdict: z
        .object({
          source: z.string(),
          verdict: z.enum(['visible', 'hidden', 'removed']),
          at: z.string().nullish(),
        })
        .nullable(),
    })
  ),
  next: z.string().nullable(),
});
export type PlatformCommentItem = z.infer<typeof commentsPageSchema>['items'][number];
