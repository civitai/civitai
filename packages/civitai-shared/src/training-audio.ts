/** YuE2 sampling expects native style/lyrics text; dataset captions also accept the XML form. */
export function formatYue2SamplePrompt(text: string): string {
  const caption = text.match(/<CAPTION>\s*([\s\S]*?)\s*<\/CAPTION>/i);
  const lyrics = text.match(/<LYRICS>\s*([\s\S]*?)\s*<\/LYRICS>/i);
  if (!caption && !lyrics) return text;

  const style = caption?.[1]?.trim() ?? '';
  const words = lyrics?.[1]?.trim();
  return words ? `${style}\n[Lyrics]\n${words}`.trim() : style;
}
