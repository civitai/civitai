/**
 * The free emoji set every account has, independent of cosmetics.
 *
 * These are Unicode characters, not artwork: they insert into the message as
 * plain text, so they need no ownership check, no upload pipeline, and no
 * render component. Creator emoji packs are a separate, purchasable thing
 * (868kk3t0t) and will resolve through the sticker-style token path instead.
 */
export type BaseEmoji = { slug: string; char: string; keywords?: string };

export const BASE_EMOJI: BaseEmoji[] = [
  { slug: 'smile', char: '😄', keywords: 'happy joy grin' },
  { slug: 'grin', char: '😁', keywords: 'happy teeth' },
  { slug: 'joy', char: '😂', keywords: 'laugh cry tears lol' },
  { slug: 'rofl', char: '🤣', keywords: 'laugh rolling lol' },
  { slug: 'wink', char: '😉', keywords: 'flirt' },
  { slug: 'blush', char: '😊', keywords: 'shy happy' },
  { slug: 'heart_eyes', char: '😍', keywords: 'love adore' },
  { slug: 'star_struck', char: '🤩', keywords: 'amazed wow' },
  { slug: 'kiss', char: '😘', keywords: 'love blow' },
  { slug: 'thinking', char: '🤔', keywords: 'hmm consider' },
  { slug: 'neutral', char: '😐', keywords: 'meh blank' },
  { slug: 'smirk', char: '😏', keywords: 'sly' },
  { slug: 'sweat_smile', char: '😅', keywords: 'nervous phew' },
  { slug: 'sob', char: '😭', keywords: 'cry sad tears' },
  { slug: 'weary', char: '😩', keywords: 'tired done' },
  { slug: 'pleading', char: '🥺', keywords: 'puppy eyes please' },
  { slug: 'scream', char: '😱', keywords: 'shock fear' },
  { slug: 'rage', char: '😠', keywords: 'angry mad' },
  { slug: 'sunglasses', char: '😎', keywords: 'cool' },
  { slug: 'nerd', char: '🤓', keywords: 'glasses smart' },
  { slug: 'shush', char: '🤫', keywords: 'quiet secret' },
  { slug: 'zany', char: '🤪', keywords: 'silly goofy' },
  { slug: 'melting', char: '🫠', keywords: 'melt awkward' },
  { slug: 'skull', char: '💀', keywords: 'dead dying lol' },
  { slug: 'ghost', char: '👻', keywords: 'boo spooky' },
  { slug: 'alien', char: '👽', keywords: 'ufo space' },
  { slug: 'robot', char: '🤖', keywords: 'bot ai' },
  { slug: 'clown', char: '🤡', keywords: 'joker' },
  { slug: 'fire', char: '🔥', keywords: 'lit hot flame' },
  { slug: 'sparkles', char: '✨', keywords: 'shiny magic' },
  { slug: 'star', char: '⭐', keywords: 'favorite' },
  { slug: 'zap', char: '⚡', keywords: 'lightning buzz energy' },
  { slug: 'boom', char: '💥', keywords: 'explode bang' },
  { slug: 'rainbow', char: '🌈', keywords: 'colors pride' },
  { slug: 'heart', char: '❤️', keywords: 'love red' },
  { slug: 'broken_heart', char: '💔', keywords: 'sad breakup' },
  { slug: 'thumbsup', char: '👍', keywords: 'yes ok approve +1' },
  { slug: 'thumbsdown', char: '👎', keywords: 'no disapprove -1' },
  { slug: 'clap', char: '👏', keywords: 'applause bravo' },
  { slug: 'raised_hands', char: '🙌', keywords: 'praise celebrate' },
  { slug: 'pray', char: '🙏', keywords: 'thanks please' },
  { slug: 'muscle', char: '💪', keywords: 'strong flex' },
  { slug: 'wave', char: '👋', keywords: 'hello bye' },
  { slug: 'ok_hand', char: '👌', keywords: 'perfect fine' },
  { slug: 'point_right', char: '👉', keywords: 'this that' },
  { slug: 'eyes', char: '👀', keywords: 'look watching' },
  { slug: 'brain', char: '🧠', keywords: 'smart think' },
  { slug: 'party', char: '🎉', keywords: 'celebrate tada congrats' },
  { slug: 'trophy', char: '🏆', keywords: 'win first' },
  { slug: 'gift', char: '🎁', keywords: 'present' },
  { slug: 'rocket', char: '🚀', keywords: 'launch ship fast' },
  { slug: 'art', char: '🎨', keywords: 'paint palette create' },
  { slug: 'camera', char: '📷', keywords: 'photo pic' },
  { slug: 'wrench', char: '🔧', keywords: 'fix tool' },
  { slug: 'gear', char: '⚙️', keywords: 'settings config' },
  { slug: 'bug', char: '🐛', keywords: 'issue defect' },
  { slug: 'warning', char: '⚠️', keywords: 'careful caution' },
  { slug: 'check', char: '✅', keywords: 'done yes correct' },
  { slug: 'cross', char: '❌', keywords: 'no wrong fail' },
  { slug: 'question', char: '❓', keywords: 'huh ask' },
  { slug: 'hourglass', char: '⏳', keywords: 'wait time' },
  { slug: 'cat', char: '🐱', keywords: 'kitty meow' },
  { slug: 'dog', char: '🐶', keywords: 'puppy woof' },
  { slug: 'coffee', char: '☕', keywords: 'drink caffeine' },
];

export const BASE_EMOJI_BY_SLUG = new Map(BASE_EMOJI.map((e) => [e.slug, e]));

/**
 * Emoji sent on a line of their own render large, matching how every other
 * messenger treats them. Capped so a wall of them cannot blow out the row.
 */
export const EMOJI_JUMBO_LIMIT = 6;

/**
 * Counted by grapheme, not code point. `\p{Emoji_Component}` includes ASCII
 * digits, `#` and `*`, so a code-point test treats "🔥 100" as emoji-only and
 * renders an ordinary message at jumbo size; it also splits one ZWJ family into
 * four and misses flags and keycaps entirely.
 */
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;
const KEYCAP = /\u{20E3}/u;

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined;

function isEmojiGrapheme(grapheme: string) {
  return PICTOGRAPHIC.test(grapheme) || REGIONAL_INDICATOR.test(grapheme) || KEYCAP.test(grapheme);
}

export function emojiOnlyCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  // Without Intl.Segmenter there is no safe grapheme split, and guessing here is
  // what produced the false positives — treat it as not-emoji-only.
  if (!segmenter) return 0;

  let count = 0;
  for (const { segment } of segmenter.segment(trimmed)) {
    if (!segment.trim()) continue;
    if (!isEmojiGrapheme(segment)) return 0;
    count++;
  }
  return count;
}

/** Whether a run of text is nothing but a small number of emoji. */
export function isJumboEmojiText(text: string): boolean {
  const count = emojiOnlyCount(text);
  return count > 0 && count <= EMOJI_JUMBO_LIMIT;
}
