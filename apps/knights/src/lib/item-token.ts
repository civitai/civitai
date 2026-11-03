export type HeldToken = { key: string; token: string };

/** What makes two loads the same item: its image and the question asked about it. */
export const itemKey = (item: { src: string }, question: { key: string; prompt: string }) =>
  `${item.src}|${question.key}|${question.prompt}`;

/** Called when the player answers or skips: the next item may share the key, and must be sent with its own token. */
export const releaseToken = (): null => null;

/**
 * Dismissing a notice re-runs `load`, which seals the same item again with a new issue time. Keeping the token first served for
 * this item keeps the server's original issue time, so the time on the item is not restarted. The token stays sealed and untouched.
 */
export function holdToken(
  held: HeldToken | null,
  key: string | null,
  token: string | null
): HeldToken | null {
  if (key === null || token === null) return null;
  return held?.key === key ? held : { key, token };
}
