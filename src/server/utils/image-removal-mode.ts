export type ImageRemovalMode = 'grace' | 'immediate';

/** Absent means immediate: backlog accounts predate the choice and must keep hard-delete. */
export function imageRemovalMode(removeImages?: boolean): ImageRemovalMode {
  return removeImages === false ? 'grace' : 'immediate';
}
