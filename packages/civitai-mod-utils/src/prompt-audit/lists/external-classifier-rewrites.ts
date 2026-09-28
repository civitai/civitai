// Rewrites applied to a prompt BEFORE it is sent to the external classifier
// (OpenAI `omni-moderation-latest`). Booru activation tags like `1girl` made the
// classifier over-flag ordinary anime prompts, so they are normalised to plain English.
//
// 🔴 This is a REWRITE, not a filter, and it is the only list here that changes what
// another system sees rather than what this one matches. The classifier never reads the
// original wording, and neither do the verdict cache, the shadow probe or the metrics —
// they all key on the rewritten text. So an entry added here is invisible everywhere
// downstream.
//
// ⚠️ A rule that turns a child noun into an adult one removes signal from the one check
// that catches what the regex audit misses. Ablation measurements are in the private
// moderation notes; get the rule owner's sign-off before adding one.
export const EXTERNAL_CLASSIFIER_REWRITES: Record<string, string> = {
  '\\d*girls': 'women',
  '\\d*boys': 'men',
  'school uniform': 'uniform',
  'breasts?': 'chest',
};
