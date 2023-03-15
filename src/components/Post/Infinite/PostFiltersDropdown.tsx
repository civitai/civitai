import { Stack } from '@mantine/core';
import { BrowsingModeFilter } from '~/components/Filters/BrowsingModeFilter';
import { FiltersDropdown } from '~/components/Filters/FiltersDropdown';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';

export function PostFiltersDropdown() {
  const currentUser = useCurrentUser();
  const showNSFWToggle = !currentUser || currentUser.showNsfw;

  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const defaultBrowsingMode = showNSFWToggle ? BrowsingMode.All : BrowsingMode.SFW;

  const count = showNSFWToggle && browsingMode !== defaultBrowsingMode ? 1 : 0;

  if (!showNSFWToggle) return null;

  return (
    <FiltersDropdown count={count}>
      <Stack>{showNSFWToggle && <BrowsingModeFilter />}</Stack>
    </FiltersDropdown>
  );
}
