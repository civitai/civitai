// Leaf module: imported by server services and client hooks alike, so it must import nothing.

export const PROMPT_ENHANCEMENT_TAGS = ['prompt-enhancement'];
export const PROMPT_ENHANCEMENT_STEP_NAME = 'prompt-enhancement';

type StepLike = { $type?: string; name?: string | null };

export function findPromptEnhancementStep<S extends StepLike>(
  workflow: { steps?: S[] | null } | null | undefined
): S | undefined {
  return workflow?.steps?.find(
    (s) => s.$type === 'promptEnhancement' || s.name === PROMPT_ENHANCEMENT_STEP_NAME
  );
}
