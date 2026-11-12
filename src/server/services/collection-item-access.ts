import type { CollectionContributorPermissionFlags } from '~/server/services/collection.service';
import { CollectionReadConfiguration } from '~/shared/utils/prisma/enums';

/**
 * Whether the viewer may see other people's items in a collection: read or manage. Write alone does
 * not count: a Private collection anyone may add to keeps its entries hidden.
 *
 * Not in collection.service: tests stub that module whole (it and post.service import each other)
 * and must still run the real rule.
 */
export const canReadCollectionItems = (
  permissions: Pick<CollectionContributorPermissionFlags, 'read' | 'manage'> | null | undefined
) => !!permissions && (permissions.read || permissions.manage);

/** A collection whose items may sit in an entry every viewer reads. */
export const isCollectionReadShared = (read: string | null | undefined) =>
  read === CollectionReadConfiguration.Public || read === CollectionReadConfiguration.Unlisted;
