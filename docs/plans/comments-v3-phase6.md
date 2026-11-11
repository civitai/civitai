# CommentV3 Phase 6: teardown

Built 2026-11-10, not deployed.

Phase 5 removed every user-facing code path on the old comment tables (`Comment`, `CommentReaction`,
`CommentReport`, `CommentV2`, `CommentV2Reaction`, `CommentV2Report`, `Thread`, `ThreadMute`). Four
deliberate readers stayed: reaction erasure, the personal-data export, and the CSAM comment archive
and hold context text. Phase 6 removes them, the Prisma models and the tables themselves. The
checklist is `docs/comments-consolidation-checklist.md` → "Phase 6".

## What changes

- **Schema:** the eight models and their reverse relations leave `schema.full.prisma`, and
  `CommentV3.removedByAuthor` goes with them (the Phase 5 reverse copy used it; the
  previous build's personal-data export still selects it).
- **Code:** the two CSAM readers that still read CommentV2 rows never copied to CommentV3 read
  CommentV3 only. On prod those rows are Q&A and club-post comments, which are dropped with the
  tables (Briant, 2026-11-10 and 2026-11-11). Reaction erasure, the personal-data export registry
  and the reaction selector stop naming the old tables. `comment.schema.ts` folds into
  `commentv3.schema.ts`.
- **Migration `20270102120000_comment_v3_teardown`:** drops the functions taking old-table row
  types, the eight tables, the old count and mirror functions, the orphan purge's `archive` schema,
  the parity job's KeyValue row and `CommentV3.removedByAuthor`. It keeps
  `comment_shared_id_seq`, which CommentV3 draws its ids from.
- **Tests:** the moderation, scam-cleanup and write SQL tests replay the migration history through
  the teardown, and one checks what it drops and keeps. `comment-v3-mirror.sql.behavior` is deleted.

## Deploy

1. Merge and deploy the main app. Its client no longer knows the old tables, which still exist.
   Comment surfaces are unchanged; the personal-data export and the CSAM comment archive stop
   including old-table rows from this deploy on (see step 2).
2. Then apply the migration by hand on each writable environment. The held users' comments in the
   orphan purge's `archive` schema, their only copy, went to the CSAM bucket on 2026-11-11. Not before
   the deploy: the previous build still reads the old tables for reaction erasure, the
   personal-data export and the CSAM comment archive and context text, and selects
   `CommentV3.removedByAuthor`.

   Apply it soon after the deploy: until then the new build's personal-data export and CSAM comment
   archive skip rows the old tables still hold. Use a quiet window and expect to retry: dropping the
   tables also locks the tables they reference (`User`, `Image`, `Post` and others) for the length of
   the statement, bounded by the 3s `lock_timeout`. Ask an infra owner first whether anything outside
   this repo still replicates the old tables: the drop removes them from any publication silently,
   and a consumer that still follows them, rather than CommentV3, has had no new comments since the
   flip.
3. Check: no old table is left, and creating, editing and reacting to a comment still work.

There is no rollback for the drop. The data that is kept is in CommentV3.
