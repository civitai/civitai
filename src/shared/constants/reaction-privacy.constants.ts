import { HIDE_FROM_REACTION_LISTS_KEY as sharedKey } from '@civitai/shared/reaction-privacy';
import type { UserSettingsSchema } from '~/server/schema/user.schema';

export const HIDE_FROM_REACTION_LISTS_KEY = sharedKey satisfies keyof UserSettingsSchema;

/** Stands in for an opted-out reactor. No real user has id 0, so it never matches a viewer or links anywhere. */
export const HIDDEN_REACTOR_ID = 0;

export const HIDE_FROM_REACTION_LISTS_LABEL =
  "Hide me from 'who reacted' and 'who collected' lists";
export const HIDE_FROM_REACTION_LISTS_DESCRIPTION =
  'Creators and other users will not see your name when you react to or publicly collect their content. Your reactions still count, and you still see your own.';
