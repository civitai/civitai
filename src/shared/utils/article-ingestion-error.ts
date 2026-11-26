/** Why an article's safety scan could not finish, in the words its owner is shown. */
export function articleIngestionErrorReason({
  errorImages,
  missingImages,
  textError,
}: {
  errorImages: number;
  missingImages: number;
  textError: boolean;
}): string | null {
  const parts: string[] = [];
  if (errorImages) parts.push(`${errorImages} image(s) could not be scanned`);
  if (missingImages) parts.push(`${missingImages} image(s) could not be found`);
  if (textError) parts.push('the text check could not finish');
  if (parts.length < 2) return parts[0] ?? null;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
