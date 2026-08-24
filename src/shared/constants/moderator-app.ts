/**
 * Re-export only. The builders moved to `@civitai/shared/moderator-paths` so `apps/moderator` reads the
 * same definitions — they had already drifted, and the copy that goes stale is the one that becomes a
 * dead link when the transitional `/retool/` namespace moves.
 *
 * Kept as a module rather than rewriting the call sites: the import path is the stable thing here, and
 * churning nine files to delete a two-line file is not worth the diff.
 */
export {
  moderatorUserLookupPath,
  moderatorImageLookupPath,
  moderatorArticleLookupPath,
  moderatorBulkImageManagerPath,
  type BulkImageManagerSource,
} from '@civitai/shared/moderator-paths';
