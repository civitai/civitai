import { removeTags } from '~/utils/string-helpers';

/** The model and public-version text the text scan reads (`loadModelScanSubjects`), as stored. */
export type ScanRatedText = {
  name: string | null;
  description: string | null;
  versions: { name: string | null; description: string | null; trainedWords: string[] }[];
};

const MAX_NAMED_VERSIONS = 5;
const MAX_VERSION_NAME_CHARS = 60;

const hasText = (value: string | null | undefined) => !!value?.trim();
const htmlHasText = (value: string | null) => !!value && hasText(removeTags(value));

function joinList(items: string[]) {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function quoteVersionName(name: string) {
  const trimmed = name.trim();
  const chars = Array.from(trimmed);
  return `"${
    chars.length > MAX_VERSION_NAME_CHARS
      ? `${chars.slice(0, MAX_VERSION_NAME_CHARS).join('').trimEnd()}…`
      : trimmed
  }"`;
}

/**
 * Why an owner cannot untick mature on a model the text scan rated: every field the scan read
 * that has text, naming the published versions. Built only from the owner's own stored text.
 */
export function scanRatingKeptMessage({ name, description, versions }: ScanRatedText) {
  const parts: string[] = [];
  if (hasText(name)) parts.push('its title');
  if (htmlHasText(description)) parts.push('its description');

  const versionKinds = [
    versions.some((v) => hasText(v.name)) && 'names',
    versions.some((v) => htmlHasText(v.description)) && 'descriptions',
    versions.some((v) => hasText(v.trainedWords.join(', '))) && 'trained words',
  ].filter((kind): kind is string => !!kind);
  if (versionKinds.length) {
    const named = versions
      .map((v) => v.name)
      .filter((value): value is string => hasText(value))
      .map(quoteVersionName);
    const shown = named.slice(0, MAX_NAMED_VERSIONS);
    const more = named.length - shown.length;
    const list = more > 0 ? `${shown.join(', ')}, and ${more} more` : joinList(shown);
    parts.push(
      `the ${joinList(versionKinds)} of its published versions${list ? ` (${list})` : ''}`
    );
  }

  const source = parts.length
    ? `its text on civitai.red, which includes ${joinList(parts)}`
    : 'its text on civitai.red';
  return `This model is marked mature because of ${source}. It stays marked mature until that text changes: edit it and save, and once the new text is checked and passes, you can change the rating.`;
}
