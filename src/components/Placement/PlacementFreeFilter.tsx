import { Chip } from '@mantine/core';

/**
 * Show or hide the free rows in a review queue. A chip rather than a switch, on
 * Justin's call, so it sits beside the select-all control as one row of queue
 * controls.
 *
 * Shared across the sticker queue and the remix submission queue because an
 * owner meets the same decision on both, and the two queues are meant to read
 * as one system — the free badge on a row is already the same badge in both
 * places.
 *
 * Filters what is already loaded rather than what is fetched. Both queues are
 * cursor-paged and both say something careful about a page whose rows were all
 * dropped ("nothing on this page can be shown — there are more waiting"); a
 * server-side filter changes what a page contains and makes that copy describe
 * something else.
 */
export function PlacementFreeFilter({
  show,
  onChange,
  /** Plural of what the queue holds: `placements`, `submissions`. */
  noun,
}: {
  show: boolean;
  onChange: (show: boolean) => void;
  noun: string;
}) {
  return (
    <Chip size="xs" checked={show} onChange={onChange} variant="light" className="shrink-0">
      Free {noun}
    </Chip>
  );
}
