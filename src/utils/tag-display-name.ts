/**
 * Display form of a tag. Tag names are stored lowercase, so the fallback capitalises each word —
 * a tag whose casing that gets wrong ("LoRA", "ComfyUI") carries its own `Tag.displayName`.
 */
export function tagDisplayName({
  name,
  displayName,
}: {
  name: string;
  displayName?: string | null;
}): string {
  if (displayName) return displayName;
  return name
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}
