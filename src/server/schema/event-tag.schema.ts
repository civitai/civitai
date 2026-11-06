import * as z from 'zod';
import {
  EVENT_TAG_MAX_LENGTH,
  EVENT_TAG_PATTERN,
  MAX_EVENT_TAGS,
  normalizeEventTag,
} from '~/shared/constants/event-tag.constants';

export const eventTagSchema = z
  .string()
  .transform(normalizeEventTag)
  .pipe(
    z
      .string()
      .min(1)
      .max(EVENT_TAG_MAX_LENGTH)
      .regex(EVENT_TAG_PATTERN, 'Use letters, numbers and dashes')
  );

/** A row's whole tag list: normalised, at most `MAX_EVENT_TAGS`, duplicates dropped. */
export const eventTagsSchema = z
  .array(eventTagSchema)
  .max(MAX_EVENT_TAGS)
  .transform((tags) => [...new Set(tags)]);
