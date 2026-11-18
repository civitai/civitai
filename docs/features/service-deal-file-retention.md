# Creator Services: deal file retention

> Deal files are deleted 30 days after a deal is declined, expires or is canceled, and 90 days after a completed deal's dispute window ends. Download anything you want to keep.

That line is shown beside the files on a completed deal (`SERVICE_DEAL_FILE_RETENTION_NOTICE`).

- **Windows:** `SERVICE_DEAL_FILE_RETENTION_CLOSED_MS` and `SERVICE_DEAL_FILE_RETENTION_COMPLETED_MS`.
- **Which files:** all of a deal's files, meaning the seller's previews and finals and the buyer's attachments.
- **The clock:** it starts at the close (for a completed deal, at the end of its dispute window), once the deal's Buzz has settled. Any later moderation of the deal or its offering restarts it: a dispute ruling, a takedown, or a report and its handling.
- **Holds:** a deal whose parties or offering are under a legal or moderation hold keeps its files until the hold clears. The rules are `dealFilesHeld` in `src/server/services/creator-service-deal-file-retention.ts`. The purge checks them again before it deletes.
- **How:** `markExpiredDealFiles` runs in the `creator-service-unpack` job and marks expired files removed. `purgeRemovedFiles` then deletes every stored version of the upload, a zip's rebuilt archive and a published preview's copy, and after that the row. A file whose scan never passed stays for moderators, as with any removed file.
- **Record:** `ServiceDealFilePurge` keeps the file id, deal id, size, the upload's storage ETag and the deletion time. It keeps no name and no content.
- **Account deletion:** `deleteUser` marks the user's own uploads to closed, settled deals removed, under the same holds. On a deal still open or unsettled, theirs and the other party's files keep the deal's clock.
