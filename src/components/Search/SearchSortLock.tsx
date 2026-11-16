import { Tooltip } from '~/components/MantineOverlays';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';

/** A feed's sort while it answers a search: the search ranks by match, so no feed sort applies. */
export function SearchSortLock() {
  return (
    <Tooltip label="Clear the search to sort the feed" withArrow>
      <div>
        <SelectMenuV2
          label="Best match"
          value="best-match"
          options={[{ label: 'Best match', value: 'best-match' }]}
          onClick={() => undefined}
          disabled
        />
      </div>
    </Tooltip>
  );
}
