import type { CollectionContributorPermissionFlags } from '~/server/services/collection.service';

/**
 * Whether the viewer may see other people's items in a collection: read or manage (moderators get
 * manage when the permissions are read with isModerator). Write alone does not count: a Private
 * collection anyone may add to keeps its entries hidden.
 *
 * Its own module, not collection.service, so tests that stub collection.service whole (it and
 * post.service import each other) still run the real rule.
 */
export const canReadCollectionItems = (
  permissions: Pick<CollectionContributorPermissionFlags, 'read' | 'manage'> | null | undefined
) => !!permissions && (permissions.read || permissions.manage);
