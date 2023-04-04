import { Stack } from '@mantine/core';
import { FiltersDropdown } from '~/components/Filters/FiltersDropdown';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function PostFiltersDropdown() {
  const currentUser = useCurrentUser();
  const showNSFWToggle = !currentUser || currentUser.showNsfw;

  const count = 0;

  if (!showNSFWToggle) return null;

  return (
    <FiltersDropdown count={count}>
      <>No Content</>
      {/* <Stack>{showNSFWToggle && <BrowsingModeFilter />}</Stack> */}
    </FiltersDropdown>
  );
}
