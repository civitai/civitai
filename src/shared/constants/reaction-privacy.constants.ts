import {
  HIDE_FROM_REACTION_LISTS_KEY as sharedKey,
  SHOW_PRE_LAUNCH_REACTIONS_KEY as sharedShowKey,
} from '@civitai/shared/reaction-privacy';
import type { UserSettingsSchema } from '~/server/schema/user.schema';

export const HIDE_FROM_REACTION_LISTS_KEY = sharedKey satisfies keyof UserSettingsSchema;
export const SHOW_PRE_LAUNCH_REACTIONS_KEY = sharedShowKey satisfies keyof UserSettingsSchema;

/** Stands in for an opted-out reactor. No real user has id 0, so it never matches a viewer or links anywhere. */
export const HIDDEN_REACTOR_ID = 0;

export const HIDE_FROM_REACTION_LISTS_LABEL =
  "Hide me from 'who reacted' and 'who collected' lists";
export const HIDE_FROM_REACTION_LISTS_DESCRIPTION =
  'Creators and other users will not see your name when you react to or publicly collect their content. Your reactions still count, and you still see your own.';

export const SHOW_PRE_LAUNCH_REACTIONS_LABEL =
  "Show my older image reactions in 'who reacted' lists";
export const SHOW_PRE_LAUNCH_REACTIONS_DESCRIPTION =
  'Image reactions you made before September 23, 2026, when creators could first see who reacted, stay out of those lists unless you turn this on.';
