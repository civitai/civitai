/**
 * Which of the files a user just picked may be attached to a feedback report.
 *
 * Pure, and separate from the component, for two reasons. It is the only place the
 * count cap and the size cap are applied, so having one function makes "the rules"
 * a single object rather than a predicate open-coded across handlers. And it lives
 * in the `unit` test project, which is the tier that actually gates — a rule pinned
 * only by a browser-mode component test rides on the PR preview pipeline, which is
 * report-only and skipped whenever the preview build fails.
 */
export type AttachmentSelection = {
  /** In picked order, already trimmed to the remaining slots. */
  accepted: File[];
  /** Dropped for exceeding `maxBytes`. */
  rejectedForSize: File[];
  /** Dropped because the count cap was already reached or would be exceeded. */
  rejectedForCount: File[];
};

export type SelectAttachmentsArgs = {
  selected: File[];
  /** How many attachments are already on the draft. */
  alreadyAttached: number;
  maxCount: number;
  maxBytes: number;
};

/**
 * SIZE IS CHECKED BEFORE COUNT, deliberately. The other order lets one oversized
 * file consume a slot and then be thrown away, so a user who picks
 * `[60MB, small, small]` against a 3-slot cap would end up with two attachments and
 * no way to see why. Filtering by size first means the slots go to files that can
 * actually be sent.
 */
export function selectAttachments({
  selected,
  alreadyAttached,
  maxCount,
  maxBytes,
}: SelectAttachmentsArgs): AttachmentSelection {
  const rejectedForSize: File[] = [];
  const withinSize: File[] = [];
  for (const file of selected) {
    if (file.size > maxBytes) rejectedForSize.push(file);
    else withinSize.push(file);
  }

  // `Math.max(0, …)` because `alreadyAttached` is a live count from component state
  // and a negative remaining would make `slice` count from the end of the array.
  const remaining = Math.max(0, maxCount - alreadyAttached);

  return {
    accepted: withinSize.slice(0, remaining),
    rejectedForSize,
    rejectedForCount: withinSize.slice(remaining),
  };
}
