import { createHmac } from 'crypto';
import Sqids from 'sqids';
import { env } from '~/env/server';
import { isProd } from '~/env/other';

/**
 * The public identifier for a hub. `UserHub.id` is a dense autoincrement, and a hub's
 * page and its link-preview card both answer unauthenticated — so an int in the URL
 * makes every public hub walkable by counting. This encodes it instead.
 *
 * 🔴 SERVER ONLY, and that is the whole point. The salt is a server env var, so the
 * client never encodes: it receives `key` already encoded on the hub it fetched, and
 * `hubUrl` builds the path from that. Moving this to a `NEXT_PUBLIC_` var would ship
 * the salt in the JS bundle and make the encoding decorative.
 *
 * It is obfuscation, not authorisation. Every read still applies `hubViewerWhere`, so
 * a decoded id buys nothing a guessed one would not — this only removes cheap
 * enumeration. Justin's call, 2026-08-27, over a random key column: one fewer value
 * to store and one fewer index.
 *
 * 🔴 That property is only worth anything while NO other procedure both accepts an
 * int and returns hub data. `follow`/`unfollow` used to, and `getFollowed` returns
 * `key` — which handed the key to any signed-in caller for the counting price. They
 * are keyed now. Adding a fourth int-addressed hub verb re-opens it.
 */
const MIN_LENGTH = 8;

// Characters that survive being read aloud, hand-copied out of a chat message, or
// double-clicked as one word. The salt permutes this, so it is the character SET,
// not the output order.
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Sqids has no salt parameter — the alphabet ORDER is the secret, so the salt is
 * applied by permuting it.
 *
 * Keyed hash, deliberately, and exported so it can be tested without the env: the
 * first version folded the salt into a 32-bit seed and drove Fisher-Yates from an
 * LCG, which capped the whole space at ~2^24 alphabets no matter how long the salt
 * was — measured at ~530k derivations/sec, so every one of them was reachable in
 * under a minute from the alphabet above, which is committed in a PUBLIC repo. Here
 * the full salt is the HMAC key and the digest is the sort rank, so there is no fold,
 * no modulo bias and no hand-rolled arithmetic.
 *
 * Ties are broken by the character itself so the result is a function of the salt
 * alone — two pods must produce identical URLs.
 */
export function permuteAlphabet(alphabet: string, salt: string) {
  if (!salt) return alphabet;

  return alphabet
    .split('')
    .map((char) => ({ char, rank: createHmac('sha256', salt).update(char).digest('hex') }))
    .sort((a, b) => (a.rank === b.rank ? (a.char < b.char ? -1 : 1) : a.rank < b.rank ? -1 : 1))
    .map(({ char }) => char)
    .join('');
}

const sqids = new Sqids({
  alphabet: permuteAlphabet(ALPHABET, env.HUB_ID_SALT),
  minLength: MIN_LENGTH,
});

export function encodeHubId(id: number) {
  // Fail LOUD rather than fail decorative. With no salt the alphabet is the constant
  // above, which is committed in a public repo, so every key is decodable and
  // forgeable by anyone — and nothing about the output looks any different, which is
  // what makes an unset value in production the dangerous case rather than the safe
  // one.
  //
  // Checked here and not in the env schema on purpose: `~/env/server` validates at
  // import with no build-time escape, so a required var would have to be present for
  // `next build` too, in every image and preview pipeline. Nothing encodes a hub id
  // during a build — `/hubs/[id]` is SSR, never prerendered — so this placement
  // catches a misconfigured deploy without adding a build-time surface.
  if (isProd && !env.HUB_ID_SALT) throw new Error('HUB_ID_SALT is not set');

  return sqids.encode([id]);
}

/**
 * Null for anything that is not a key this instance would have produced — including a
 * bare integer, which is the pre-encoding URL format. Accepting those back would leave
 * enumeration exactly as open as it was, so an old link 404s rather than resolving.
 */
export function decodeHubId(key: string | undefined) {
  if (!key) return null;

  const decoded = sqids.decode(key);
  if (decoded.length !== 1) return null;

  const id = decoded[0];
  if (!Number.isSafeInteger(id) || id < 1) return null;

  // Sqids decodes strings it never emitted, so the round trip is the check: only a
  // key this alphabet and minLength would have produced survives it.
  return encodeHubId(id) === key ? id : null;
}
