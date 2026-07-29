import {
  CollectionContributorPermission,
  CollectionReadConfiguration,
} from '~/shared/utils/prisma/enums';

/**
 * Whether a viewer may see a post that belongs to `collection`, based on the
 * collection's read setting and the viewer's contributor permissions.
 *
 * `contributors` is only selected when the `post.getInfinite` request has a
 * logged-in user (see the `collection.findMany` select in post.service.ts) — for
 * anonymous viewers the field is absent (`undefined`). Indexing `contributors[0]`
 * without guarding that threw `Cannot read properties of undefined (reading '0')`
 * for every logged-out viewer of a non-Public collection (prod 500s on
 * post.getInfinite). The `?.` before `[0]` is the guard; the result then means
 * "no VIEW permission" → hide the post, which is the correct behaviour for an
 * anonymous viewer of a private/unlisted collection.
 *
 * Kept in a standalone (import-light) module so it is unit-testable without the
 * full post.service dependency graph.
 */
export const canViewCollectionPost = (collection: {
  read: CollectionReadConfiguration;
  contributors?: { permissions: CollectionContributorPermission[] }[];
}) => {
  if (collection.read === CollectionReadConfiguration.Public) return true;
  return !!collection.contributors?.[0]?.permissions.includes(
    CollectionContributorPermission.VIEW
  );
};
