import { workflowConfigByKey } from '~/shared/generation/config/workflows';

/**
 * The orchestrator's output cap for a submit. Private generation and workflows whose config sets
 * `maxNsfwLevel` (avatars, which depict a real person) are held to PG-13 with mature content
 * refused; everything else keeps the caller's choice.
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
  if (isPrivateGeneration || workflowConfigByKey.get(workflow)?.maxNsfwLevel === 'pg13')
    return { nsfwLevel: 'pg13' as const, allowMatureContent: false };
  return { nsfwLevel: undefined, allowMatureContent };
}
