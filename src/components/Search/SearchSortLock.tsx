import type { ReactNode } from 'react';
import { Tooltip } from '~/components/MantineOverlays';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import { useTapTooltip } from '~/hooks/useTapTooltip';

/** A feed control greyed out while the feed answers a search, with the reason on hover and on tap. */
export function SearchLock({ reason, children }: { reason: string; children: ReactNode }) {
  const { opened, ref, triggerProps } = useTapTooltip<HTMLDivElement>();

  return (
    <Tooltip label={reason} withArrow opened={opened}>
      <div
        ref={ref}
        // Some browsers drop a tap on a disabled button before it reaches the wrapper.
        className="[&_button]:pointer-events-none"
        {...triggerProps}
      >
        {children}
      </div>
    </Tooltip>
  );
}

/** A feed's sort while it answers a search: the search ranks by match, so no feed sort applies. */
export function SearchSortLock() {
  return (
    <SearchLock reason="Clear the search to sort the feed">
      <SelectMenuV2
        label="Best match"
        value="best-match"
        options={[{ label: 'Best match', value: 'best-match' }]}
        onClick={() => undefined}
        disabled
      />
    </SearchLock>
  );
}

const BEST_MATCH = 'best-match';

/** A search's sort: Best match (the default), or one of `sorts` over the best matches. */
export function SearchSortMenu<T extends string>({
  sorts,
  value,
  onChange,
}: {
  sorts: readonly { value: T; label: string }[];
  value: T | undefined;
  onChange: (value: T | undefined) => void;
}) {
  return (
    <SelectMenuV2
      label={sorts.find((x) => x.value === value)?.label ?? 'Best match'}
      value={value ?? BEST_MATCH}
      options={[{ label: 'Best match', value: BEST_MATCH }, ...sorts]}
      onClick={(picked: string) => onChange(sorts.find((x) => x.value === picked)?.value)}
    />
  );
}
