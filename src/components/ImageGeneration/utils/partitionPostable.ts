import type { OutputUse } from '~/shared/generation/config/types';

type PostCandidate = {
  mediaType: string;
  canUse: (use: OutputUse) => { allowed: true } | { allowed: false; message: string };
};

/** Splits a selection into postable outputs and one notice for the rest. */
export function partitionPostable<T extends PostCandidate>(outputs: T[]) {
  const postable: T[] = [];
  const reasons = new Set<string>();
  for (const output of outputs) {
    const use = output.canUse('post');
    if (output.mediaType === 'audio') reasons.add("Audio outputs can't be added to a post");
    else if (!use.allowed) reasons.add(use.message);
    else postable.push(output);
  }

  const skipped = outputs.length - postable.length;
  if (!skipped) return { postable };
  const why = `${[...reasons].join('. ')}.`;
  if (!postable.length)
    return {
      postable,
      notice: {
        kind: 'error' as const,
        title: 'None of the selected outputs can be posted',
        message: why,
      },
    };
  return {
    postable,
    notice: {
      kind: 'warning' as const,
      title: 'Some outputs were left out',
      message: `${skipped} of ${outputs.length} selected outputs can't be posted. ${why}`,
    },
  };
}
