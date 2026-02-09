/**
 * Resolves @mentions in a prompt string to reference IDs.
 * Matches case-insensitively against the provided reference names.
 * Supports names with non-ASCII characters (accented letters, etc.).
 */
export function resolveReferenceMentions(input: {
  prompt: string;
  references: { id: string; name: string }[];
}): { mentionedIds: string[]; resolvedPrompt: string } {
  const { prompt, references } = input;
  if (references.length === 0) return { mentionedIds: [], resolvedPrompt: prompt };

  const mentionedIds = new Set<string>();
  let resolvedPrompt = prompt;

  // Sort by name length descending so longer names match first (e.g., @MayaWarrior before @Maya)
  const sorted = [...references].sort((a, b) => b.name.length - a.name.length);

  for (const ref of sorted) {
    const escaped = ref.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Use lookahead for end-of-mention boundary instead of \b (which breaks on non-ASCII)
    const pattern = new RegExp(`@${escaped}(?=$|[\\s.,!?;:'")])`, 'gi');
    if (pattern.test(resolvedPrompt)) {
      mentionedIds.add(ref.id);
      // Replace @Name with just Name (strip the @) — recreate regex since .test() advances lastIndex
      resolvedPrompt = resolvedPrompt.replace(
        new RegExp(`@${escaped}(?=$|[\\s.,!?;:'")])`, 'gi'),
        ref.name
      );
    }
  }

  return {
    mentionedIds: Array.from(mentionedIds),
    resolvedPrompt,
  };
}
