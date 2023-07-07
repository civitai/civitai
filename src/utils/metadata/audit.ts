import { ImageMetaProps } from '~/server/schema/image.schema';
import blockedNSFW from '../blocklist-nsfw.json';
import blocked from '../blocklist.json';

// #region [audit]
const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blockedBoth = '\\%|\\~|\\\\$|\\.|-|\\(|\\)|\\[|\\]|\\{|\\}|:|\\|';
const tokenRegex = (word: string) =>
  new RegExp(`(^|\\s|,|${blockedBoth})${escapeRegex(word)}(\\s|,|$|${blockedBoth})`, 'm');
const blockedRegex = blocked.map((word) => ({
  word,
  regex: tokenRegex(word),
}));
const blockedNSFWRegex = blockedNSFW.map((word) => ({
  word,
  regex: tokenRegex(word),
}));
export const auditMetaData = (meta: ImageMetaProps | undefined, nsfw: boolean) => {
  if (!meta) return { blockedFor: [], success: true };

  const blockList = nsfw ? blockedNSFWRegex : blockedRegex;
  const blockedFor = blockList
    .filter(({ regex }) => meta?.prompt && regex.test(meta.prompt))
    .map((x) => x.word);
  return { blockedFor, success: !blockedFor.length };
};

export const auditPrompt = (prompt: string) => {
  for (const { word, regex } of blockedNSFWRegex) {
    if (regex.test(prompt)) return { blockedFor: [word], success: false };
  }

  return { blockedFor: [], success: true };
};
// #endregion
