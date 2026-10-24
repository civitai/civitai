import { HubFeedFilters } from '~/components/Filters/FeedFilters/HubFeedFilters';
import { HubPicker } from '~/components/Hubs/HubPicker';

/**
 * The hub's own row in the sticky bar, below `sm` only: which hub you are looking at,
 * then this feed's sort and filters, on one line.
 *
 * `HubFeedFilters` is given a className, which REPLACES its `filtersWrapper` class —
 * that is what makes the controls full width with `flex-grow` children below `sm`,
 * and full width is exactly what stops them sharing this line.
 *
 * Wider screens get none of this: the sidebar switches hubs and the filters sit in
 * the site row with every other feed's. The strip styles itself rather than leaning
 * on the row AppLayout renders, so hiding it leaves no empty bar behind.
 */
export function HubPageNav() {
  return (
    <div className="flex w-full flex-nowrap items-center gap-2 overflow-x-auto border-t border-gray-3 bg-gray-0 px-2 py-1.5 @sm:hidden dark:border-dark-4 dark:bg-dark-6">
      <HubPicker />
      {/* Icons only: `FilterButton` puts its label in a span beside the icon, and
          `sr-only` rather than `hidden` keeps the button's accessible name. */}
      <HubFeedFilters className="flex flex-nowrap items-center gap-2 [&_button>span]:sr-only" />
    </div>
  );
}
