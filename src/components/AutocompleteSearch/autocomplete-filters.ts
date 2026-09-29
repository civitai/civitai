import { quoteMeiliValue } from '~/components/Search/meili-filter';
import { buildMinorExclusionFilter } from '~/components/Search/search-filters';
import type { SearchIndexKey } from '~/components/Search/search.types';
import { Availability } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';

type Viewer = { id?: number; username?: string | null; isModerator?: boolean | null } | null;

export function buildAutocompleteBaseFilters({
  targetIndex,
  addons,
  currentUser,
}: {
  targetIndex: SearchIndexKey;
  addons: { disablePoi?: boolean; disableMinor?: boolean };
  currentUser?: Viewer;
}) {
  const isModels = targetIndex === 'models';
  const isImages = targetIndex === 'images';
  const supportsPoi = ['models', 'images'].includes(targetIndex);

  return [
    isModels && supportsPoi && addons.disablePoi
      ? `poi != true${currentUser?.id ? ` OR user.id = ${currentUser?.id}` : ''}`
      : null,
    isImages && supportsPoi && addons.disablePoi
      ? `poi != true${
          currentUser?.username
            ? ` OR user.username = ${quoteMeiliValue(currentUser.username)}`
            : ''
        }`
      : null,
    buildMinorExclusionFilter({ targetIndex, addons, currentUser }),
    isModels && !currentUser?.isModerator
      ? `availability != ${Availability.Private}${
          currentUser?.id ? ` OR user.id = ${currentUser?.id}` : ''
        }`
      : null,
  ].filter(isDefined);
}
