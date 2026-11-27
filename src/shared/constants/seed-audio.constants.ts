export const SEED_AUDIO_MAX_PROMPT_LENGTH = 2000;

// Seed Audio rejects a prompt with no spoken line (`SpeechContentNotSpecifiedByPrompt`).
const QUOTED_LINE = /["“”«»「」][^"“”«»「」]*\S[^"“”«»「」]*["“”«»「」]/;

export function hasQuotedSpokenLine(prompt: string) {
  return QUOTED_LINE.test(prompt);
}
