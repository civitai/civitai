import { STORYLINE_CAPTION_MAX_LENGTH } from '~/shared/utils/storyline';

/** The counter stays out of the way until a caption is nearly full. */
export const CAPTION_COUNTER_FROM = 400;

export function captionCounter(length: number) {
  return length >= CAPTION_COUNTER_FROM ? `${length} / ${STORYLINE_CAPTION_MAX_LENGTH}` : null;
}
