import Sqids from 'sqids';
import { env } from '~/env/server';

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
 */
const MIN_LENGTH = 8;

// Characters that survive being read aloud, hand-copied out of a chat message, or
// double-clicked as one word. Sqids shuffles this with the salt, so the alphabet is
// the character SET, not the output order.
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';

const sqids = new Sqids({ alphabet: shuffle(ALPHABET), minLength: MIN_LENGTH });

// Sqids has no salt parameter — the alphabet order IS the secret, so the salt is
// applied by permuting it deterministically. An empty salt leaves the alphabet as
// written, which is what dev and test run with.
function shuffle(alphabet: string) {
  const salt = env.HUB_ID_SALT;
  if (!salt) return alphabet;

  const chars = alphabet.split('');
  // Fisher-Yates driven by the salt's bytes rather than randomness, so every
  // environment holding the same salt produces the same URLs.
  let seed = 0;
  for (let i = 0; i < salt.length; i++) seed = (seed * 31 + salt.charCodeAt(i)) >>> 0;
  for (let i = chars.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const j = seed % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function encodeHubId(id: number) {
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
