import { AVATAR_WORKFLOW } from '~/shared/constants/avatar-styles.constants';

/**
 * The orchestrator's output cap for a submit. Private generation and avatars (which become profile
 * pictures) are held to PG-13 with mature content refused; everything else keeps the caller's choice.
 */
export function workflowOutputRestrictions({
  workflow,
  isPrivateGeneration,
  allowMatureContent,
}: {
  workflow: string;
  isPrivateGeneration: boolean;
  allowMatureContent?: boolean;
}) {
  if (isPrivateGeneration || workflow === AVATAR_WORKFLOW)
    return { nsfwLevel: 'pg13' as const, allowMatureContent: false };
  return { nsfwLevel: undefined, allowMatureContent };
}
