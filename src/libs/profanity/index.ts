// Re-export the main profanity filter for clean imports
export { default } from './profanity';
export { default as profanityFilter } from './profanity';
export type { ProfanityConfig } from './profanity';

// Re-export word processor utilities if needed elsewhere
export {
  processNsfwWords,
  getCachedNsfwWords,
  clearWordCache,
} from './nsfw-word-processor';