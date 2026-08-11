import type { PromptEnhancementSchema } from '~/server/schema/orchestrator/promptEnhancement.schema';
import { MAX_PROMPT_LENGTH } from '~/shared/data-graph/generation/common';

/**
 * Word budget stated to the analyzer in place of `MAX_PROMPT_LENGTH`. A character
 * count is the one unit an LLM cannot evaluate about its own output, so asking in
 * characters is close to decorative. Assumes ~6 characters per English word
 * (including the trailing space) and keeps 20% headroom, so ordinary overshoot
 * still lands inside the real cap.
 */
const MAX_PROMPT_WORDS = Math.floor((MAX_PROMPT_LENGTH / 6) * 0.8);

/**
 * Compose the per-request `instruction` sent alongside the prompt. The orchestrator
 * treats this as the primary directive, ranked above the ecosystem's static guide,
 * so anything that varies per generation belongs here rather than in a guide.
 *
 * Kept in its own module, apart from the workflow-submitting code that consumes it,
 * so it can be unit-tested without dragging in the orchestrator client, prompt
 * auditing, and their transitive imports.
 */
export function buildInstruction(input: Omit<PromptEnhancementSchema, 'ecosystem'>): string {
  const parts: string[] = [];
  const promptLower = input.prompt.toLowerCase();
  const negativeLower = (input.negativePrompt ?? '').toLowerCase();

  // Trigger words and snippet `#references` are both "leave this token alone"
  // asks, but they need different positional language:
  //   - Trigger words (LoRA activators): position doesn't matter; the LLM
  //     can place them wherever reads best in the enhanced prompt.
  //   - Snippet refs: position MATTERS to the user — the placeholder will be
  //     substituted with a random value at generation time, and the user's
  //     prompt structure was authored around where they put each `#ref`.
  //     Moving `#character` from the subject slot to the end of the prompt
  //     would silently change the composition.
  // So we emit two separate directives. Dedupe is per-list (trigger words and
  // snippets are different concepts; a coincidental name overlap should not
  // collapse them).
  const triggerWords = input.preserveTriggerWords ?? [];
  const snippetTokens = collectSnippetTokens(input);

  if (triggerWords.length > 0) {
    const inPrompt = triggerWords.filter((t) => promptLower.includes(t.toLowerCase()));
    const inNegative = triggerWords.filter((t) => negativeLower.includes(t.toLowerCase()));

    if (inPrompt.length) {
      parts.push(`Preserve these exact trigger words in the prompt: ${inPrompt.join(', ')}`);
    }
    if (inNegative.length) {
      parts.push(
        `Preserve these exact trigger words in the negative prompt: ${inNegative.join(', ')}`
      );
    }
  }

  if (snippetTokens.length > 0) {
    const inPrompt = snippetTokens.filter((t) => promptLower.includes(t.toLowerCase()));
    const inNegative = snippetTokens.filter((t) => negativeLower.includes(t.toLowerCase()));

    // Positional directive — the `#refs` are placeholders that will be
    // substituted at generation time, and where the user put them defines
    // the structural role of that substitution (subject, style, setting,
    // etc.). Asking the LLM to keep them in roughly the same place ensures
    // the enhanced prompt still composes coherently after substitution.
    if (inPrompt.length) {
      parts.push(
        `Preserve these snippet references exactly as written in the prompt, and keep each one in approximately the same position it currently occupies (do not move them to a different part of the prompt): ${inPrompt.join(
          ', '
        )}`
      );
    }
    if (inNegative.length) {
      parts.push(
        `Preserve these snippet references exactly as written in the negative prompt, and keep each one in approximately the same position it currently occupies: ${inNegative.join(
          ', '
        )}`
      );
    }
  }

  parts.push(
    input.negativePrompt != null
      ? `Keep the enhanced prompt and the enhanced negative prompt each under about ${MAX_PROMPT_WORDS} words.`
      : `Keep the enhanced prompt under about ${MAX_PROMPT_WORDS} words.`
  );

  if (input.instruction) {
    parts.push(input.instruction);
  }

  if (input.singleTake != null) {
    parts.push(
      input.singleTake
        ? 'Describe a single continuous take. Do not describe cuts, scene changes, or separate shots.'
        : 'Multiple shots with cuts between them are acceptable when the action calls for it.'
    );
  }

  // A prompt the user hand-formatted is formatted for a reason — it is how they
  // navigate and edit it. Preserving that outranks any default we would impose,
  // so it wins over the readability fallback; `segmentPrompt` is the one case
  // where they have explicitly asked for a different structure instead.
  if (input.segmentPrompt) {
    parts.push(
      'Organize the enhanced prompt into thematic segments (such as subject, setting, style, lighting, composition). Separate each segment with a blank line. Do not use bullet points or lists.'
    );
  } else if (input.prompt.includes('\n')) {
    parts.push(
      "The user's prompt is deliberately formatted across multiple lines. Preserve that line structure: keep the same breaks in the same places and make your edits within it. Do not collapse it onto one line."
    );
  } else {
    parts.push(
      'Format the enhanced prompt across multiple lines, keeping related ideas together on their own line. Do not return it as a single unbroken line. Do not use bullet points or lists.'
    );
  }

  return parts.length ? parts.join('\n') : '';
}

/**
 * Build the canonical `#category` token list to ask the LLM to preserve.
 * Unions explicit `preserveSnippets` with category names extracted from
 * `snippetTargets` (the raw `snippets.targets` map), normalizes every entry
 * to the `#`-prefixed form, and dedupes case-insensitively.
 */
function collectSnippetTokens(
  input: Pick<PromptEnhancementSchema, 'preserveSnippets' | 'snippetTargets'>
): string[] {
  const seen = new Set<string>(); // lower-case keys for case-insensitive dedupe
  const out: string[] = [];

  const push = (raw: string) => {
    const token = raw.startsWith('#') ? raw : `#${raw}`;
    const key = token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(token);
  };

  for (const ref of input.preserveSnippets ?? []) push(ref);
  if (input.snippetTargets) {
    for (const refs of Object.values(input.snippetTargets)) {
      for (const ref of refs) push(ref.category);
    }
  }
  return out;
}
