import { groupBy } from 'lodash-es';
import type { HuggingFaceImportView } from '~/server/services/huggingface-import.service';

/**
 * Groups by the batch a moderator would recognise. Revision is part of the identity: a group name
 * defaults to the repo's last path segment, so re-importing the same repo at a new revision reuses
 * the name — and collapsing those would put one revision's badge over both revisions' files, under
 * a `Delete N` that spans them.
 */
export function byGroup(rows: HuggingFaceImportView[]) {
  const groups = groupBy(rows, (row) => JSON.stringify([row.groupName, row.repo, row.revision]));
  return Object.values(groups).map((items) => ({
    groupName: items[0].groupName,
    repo: items[0].repo,
    revision: items[0].revision,
    items,
    bytes: items.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
    oldest: items.reduce(
      (oldest, item) => (item.createdAt < oldest ? item.createdAt : oldest),
      items[0].createdAt
    ),
  }));
}
