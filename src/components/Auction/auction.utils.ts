import { miscAuctionName } from '~/shared/constants/auction.constants';
import nsfwWords from '~/utils/metadata/lists/words-nsfw-soft.json';

// Re-export from shared constants for backward compatibility
export { miscAuctionName };

// Re-export from server utils for component use
export { getModelTypesForAuction } from '~/server/utils/auction.utils';

export const getCleanedNSFWWords = () => {
  return nsfwWords.filter((word) => /^[a-zA-Z ]+$/.test(word));
};

const cleanedWords = getCleanedNSFWWords();

export const hasNSFWWords = (str: string | undefined) => {
  if (!str || !str.length) return false;
  return cleanedWords.some((word) => str.toLowerCase().includes(word.toLowerCase()));
};
