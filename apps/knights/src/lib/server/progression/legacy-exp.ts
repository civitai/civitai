import { REDIS_SYS_KEYS } from '@civitai/redis';

/** The original game's exp counter: a hash keyed by user id, a cache of `NewOrderPlayer.exp`. */
export const LEGACY_EXP_KEY = REDIS_SYS_KEYS.NEW_ORDER.EXP;

export type XpDelta = { playerId: number; xp: number };
export type XpMirror = (deltas: XpDelta[]) => Promise<void>;

type EvalClient = {
  eval: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>;
};

// An absent field is re-read from Postgres by the original game, which already holds this XP; creating
// it here would seed the counter with the delta alone and the nightly reset would then overwrite exp with it.
const INCREMENT_IF_PRESENT = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  return redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[2])
end
return nil`;

export function legacyExpMirror(client: () => EvalClient): XpMirror {
  return async (deltas) => {
    for (const { playerId, xp } of deltas) {
      if (xp <= 0) continue;
      await client().eval(INCREMENT_IF_PRESENT, {
        keys: [LEGACY_EXP_KEY],
        arguments: [String(playerId), String(xp)],
      });
    }
  };
}

/** Runs after the Postgres commit; a Redis failure is logged and never fails the caller. */
export async function mirrorXp(mirror: XpMirror | undefined, deltas: XpDelta[]): Promise<void> {
  if (!mirror || deltas.length === 0) return;
  try {
    await mirror(deltas);
  } catch (error) {
    console.error('knights: could not mirror XP to the original game counter', { deltas, error });
  }
}
