import { readKnightsSourcesConfig, type KnightsGameSettings } from '@civitai/shared/new-order';
import { REDIS_TIMEOUT_MS, within } from '../redis-timeout';

/** What moderators saved on the Config page. A field that is absent leaves its reader on the environment. */
export type StoredSettings = KnightsGameSettings & {
  yesNoShare?: number;
  /** The moderator tag review source; absent is off. */
  modTagReview?: boolean;
};

export type StoredSettingsSourceOptions = {
  /** The raw `system:knights-v2-sources` value. */
  read: () => Promise<string | Buffer | null>;
  ttlMs?: number;
  now?: () => number;
  timeoutMs?: number;
};

const NOTHING_STORED: StoredSettings = {};

/**
 * The game settings saved in the moderator app, read at most once per `ttlMs` so serving an item never waits on it. A read
 * that fails or times out keeps what was known: nothing before the first good read, so every reader uses the environment.
 * The kill switches go through the same rule, so a store outage never flips the shop or conversion away from the last
 * known state.
 */
export function createStoredSettingsSource({
  read,
  ttlMs = 30_000,
  now = Date.now,
  timeoutMs = REDIS_TIMEOUT_MS,
}: StoredSettingsSourceOptions) {
  let held = NOTHING_STORED;
  let readAt = -Infinity;
  let loading: Promise<StoredSettings> | null = null;

  async function refresh(): Promise<StoredSettings> {
    try {
      const { yesNoShare, game, modTagReview } = readKnightsSourcesConfig(
        await within(read(), timeoutMs)
      ).config;
      held = {
        ...game,
        ...(yesNoShare === undefined ? {} : { yesNoShare }),
        ...(modTagReview === undefined ? {} : { modTagReview }),
      };
    } catch (error) {
      console.error('knights: could not read the saved game settings', { error });
    }
    readAt = now();
    return held;
  }

  return {
    async load(): Promise<StoredSettings> {
      if (now() - readAt < ttlMs) return held;
      loading ??= refresh().finally(() => (loading = null));
      return loading;
    },
  };
}
