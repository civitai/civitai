// Profanity vocabulary. Separate from prompt-audit/lists because it is a different
// axis — these feed the profanity filter, not the minor/POI/NSFW audit.
import blockedWords from './blocked-words.json';
import whitelistWords from './whitelist-words.json';

export { blockedWords, whitelistWords };
