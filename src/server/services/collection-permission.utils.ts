import type { CollectionMode } from '~/shared/utils/prisma/enums';
import {
  CollectionContributorPermission,
  CollectionReadConfiguration,
  CollectionWriteConfiguration,
} from '~/shared/utils/prisma/enums';

// Curated (any mode) and system-owned collections carry staff and judge rows that are an internal
// roster, not a collaboration. Lives here rather than beside the roster so the sidebar's
// `isCollaborator` flag and `getCollectionRoster` cannot apply different rules to the same row.
export function collectionSupportsCollaborators(collection: {
  userId: number;
  mode: CollectionMode | null;
}): boolean {
  return collection.mode === null && collection.userId > 0;
}

// What the collection already grants everyone for free, independent of who's asking.
// Sourced from the collection's own read/write columns — NOT from a permission result's
// `followPermissions`, which the collaborationDisabledAt lapse filter prunes; using that would
// misreport a lapsed collection's free ADD grant as elevated and undercount every follower's
// real standing.
export function freeGrantBaseline(collection: {
  read: CollectionReadConfiguration;
  write: CollectionWriteConfiguration;
}): Set<CollectionContributorPermission> {
  const baseline = new Set<CollectionContributorPermission>();
  if (
    collection.read === CollectionReadConfiguration.Public ||
    collection.read === CollectionReadConfiguration.Unlisted
  ) {
    baseline.add(CollectionContributorPermission.VIEW);
  }
  if (collection.write === CollectionWriteConfiguration.Public) {
    baseline.add(CollectionContributorPermission.ADD);
  }
  if (collection.write === CollectionWriteConfiguration.Review) {
    baseline.add(CollectionContributorPermission.ADD_REVIEW);
  }
  return baseline;
}

// A plain Follow on a write:Public collection writes a CollectionContributor row carrying ADD
// too — that row must NOT read as elevated.
export function hasElevatedPermission(
  permissions: CollectionContributorPermission[],
  freeBaseline: Set<CollectionContributorPermission>
): boolean {
  return permissions.some(
    (p) =>
      (p === CollectionContributorPermission.ADD || p === CollectionContributorPermission.MANAGE) &&
      !freeBaseline.has(p)
  );
}

/**
 * The single "is this row a collaborator" rule. Both the detail-header roster
 * (`getCollectionRoster`) and the sidebar grouping (`getUserCollectionPermissionsByIds`) call
 * this, so the two surfaces can never disagree about who is a collaborator.
 *
 * `hasAcceptedSeat` is what disambiguates a Contributor from a follower on a write:Public
 * collection, where both hold exactly {VIEW, ADD}. It must come from an **accepted** invite:
 * a Pending one would publish an invitee before they answer.
 */
export function isCollaboratorRow({
  permissions,
  freeBaseline,
  hasAcceptedSeat,
}: {
  permissions: CollectionContributorPermission[];
  freeBaseline: Set<CollectionContributorPermission>;
  hasAcceptedSeat?: boolean;
}): boolean {
  return hasElevatedPermission(permissions, freeBaseline) || !!hasAcceptedSeat;
}
