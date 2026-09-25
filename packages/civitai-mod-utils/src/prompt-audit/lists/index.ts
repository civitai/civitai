// The shared prompt-audit vocabulary, as named exports.
//
// Consumers import THIS module, never the .json files: a raw `*.json` subpath export
// would be the only place the main Next app imports JSON across a workspace boundary,
// and nothing else in the repo establishes that Turbopack resolves it. A .ts module is
// the shape every other @civitai/* package is already consumed as.
import blocked from './blocklist.json';
import blockedNSFW from './blocklist-nsfw.json';
import blockedNSFWOverridable from './blocklist-nsfw-overridable.json';
import promptTags from './prompt-tags.json';
import nsfwPromptWords from './words-nsfw-prompt.json';
import nsfwWordsSoft from './words-nsfw-soft.json';
import nsfwWordsPaddle from './words-paddle-nsfw.json';
import poiWords from './words-poi.json';
import youngWords from './words-young.json';

export {
  blocked,
  blockedNSFW,
  blockedNSFWOverridable,
  promptTags,
  nsfwPromptWords,
  nsfwWordsSoft,
  nsfwWordsPaddle,
  poiWords,
  youngWords,
};
export { harmfulCombinations, type HarmfulCombination } from './harmful-combinations';
export { EXTERNAL_CLASSIFIER_REWRITES } from './external-classifier-rewrites';
