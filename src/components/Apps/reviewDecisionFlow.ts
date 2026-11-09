/**
 * Pure pieces of the review page's decision flow: the reject-reason chips and "which
 * submission opens next". React-free so the node tier pins them.
 */

/**
 * The common rejection reasons, offered as chips under "Reject…". A chip PREFILLS the reason
 * textarea with its sentence — the moderator can edit it before confirming, and the text is
 * what the developer is shown, so each one says what to change rather than naming a category.
 * Every sentence clears the reason floor on its own, which is what makes reject three clicks
 * (Reject… → chip → Reject).
 */
export const REJECT_REASON_CHIPS = [
  {
    key: 'broken',
    label: 'Broken / doesn’t load',
    text: 'The app does not load or is broken in the review preview. Please fix it and resubmit.',
  },
  {
    key: 'policy',
    label: 'Policy / content',
    text: 'The app’s content or behaviour does not meet the content policy. Please review the policy and resubmit.',
  },
  {
    key: 'misleading',
    label: 'Misleading listing',
    text: 'The store listing (name, description or images) does not match what the app does. Please make it accurate and resubmit.',
  },
  {
    key: 'media',
    label: 'Missing or bad media',
    text: 'The store media (icon, cover or screenshots) is missing, low quality or does not show the app. Please update it and resubmit.',
  },
  {
    key: 'permissions',
    label: 'Weak permission justification',
    text: 'One or more requested permissions are not justified well enough. Explain why each sensitive permission is needed, or remove it, and resubmit.',
  },
  {
    key: 'duplicate',
    label: 'Duplicate',
    text: 'This app duplicates an existing app on the store. Please differentiate it or contribute to the existing one.',
  },
] as const;

export type RejectReasonChipKey = (typeof REJECT_REASON_CHIPS)[number]['key'];

/**
 * The submission to open after a decision: the OLDEST pending one that is not the one just
 * decided and not already waiting on a delayed approval. `pending` is expected oldest-first
 * (the queue's order), but the sort here does not rely on it.
 *
 * Returns `null` when nothing is left — the "No more app submissions waiting" state.
 */
export function nextPendingRequestId(
  pending: ReadonlyArray<{ id: string; submittedAt: string | Date }>,
  exclude: ReadonlySet<string> | ReadonlyArray<string>
): string | null {
  const skip = exclude instanceof Set ? exclude : new Set(exclude as ReadonlyArray<string>);
  const ms = (d: string | Date) => (typeof d === 'string' ? new Date(d) : d).getTime();
  const candidates = pending
    .filter((r) => !skip.has(r.id))
    .slice()
    .sort(
      (a, b) => ms(a.submittedAt) - ms(b.submittedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  return candidates[0]?.id ?? null;
}
