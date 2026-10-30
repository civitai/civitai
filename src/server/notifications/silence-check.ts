export type SilenceCheckTypeAge = { type: string; firstSeen: string };

const TTL_MS = 60 * 60 * 1000;

/**
 * Each opt-out type with the first time anyone switched it off, which dates when the type existed in
 * notification settings (the table has no index on `type`, so this is a full scan, hence the hour of
 * caching). Types nobody has switched off yet are absent. Held in this process, one query at a time,
 * with the last good list served if a refresh fails; the one caller is an hourly job.
 */
export function createSilenceCheckTypeAges({
  query,
  now = () => new Date(),
}: {
  query: (types: string[]) => Promise<{ type: string; firstSeen: Date }[]>;
  now?: () => Date;
}) {
  let cached: { at: number; value: SilenceCheckTypeAge[] } | undefined;
  let inFlight: Promise<SilenceCheckTypeAge[]> | undefined;

  const refresh = async (types: string[]) => {
    try {
      const rows = await query(types);
      const value = rows.map((row) => ({
        type: row.type,
        firstSeen: row.firstSeen.toISOString(),
      }));
      cached = { at: now().getTime(), value };
      return value;
    } catch (error) {
      // The last good list is still right about the past; only a type added since is missing.
      if (cached) return cached.value;
      throw error;
    }
  };

  return (types: string[]): Promise<SilenceCheckTypeAge[]> => {
    if (cached && now().getTime() - cached.at < TTL_MS) return Promise.resolve(cached.value);
    // One query at a time per process, however many requests arrive while it runs.
    inFlight ??= refresh(types).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
