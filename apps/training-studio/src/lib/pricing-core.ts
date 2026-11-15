import { kohyaFamily } from './data/kohya';
// Client-safe "from"-price sweep: one whatif per catalog card against a provided client. The shell
// wraps it in a global redis cache (lib/server/pricing.ts); the web-component backend runs it
// browser-side, uncached.
import {
  MODEL_CARDS,
  firstPickVersions,
  versionPriceKey,
  type FromPrices,
} from '$lib/data/trainingModels';
import { pool } from '$lib/pool';
import { trainingWhatIf, type OrchestratorClient } from './orchestrator-core';

// The estimate calls are independent one-per-model round-trips; a few at a time keeps the sweep quick
// without hammering the orchestrator with ~20 at once.
const WHATIF_CONCURRENCY = 4;

/** What the sweep quotes: each card's first version under the card type, plus every later version that
 *  can be a viewer's first pick under `versionPriceKey` (`cardFromPrice` reads them back). */
export const fromPriceQuotes = () =>
  MODEL_CARDS.flatMap((card) =>
    firstPickVersions(card).flatMap((version, i) => [
      {
        key: i === 0 ? card.type : versionPriceKey(card.type, version.key),
        version,
      },
      ...(i === 0 && kohyaFamily(version.ecosystem)
        ? [{ key: `kohya:${card.type}`, version: { ...version, engine: 'kohya' } }]
        : []),
    ])
  );

/** Per-card "from" prices via live whatif quotes. PARTIAL — a model the orchestrator can't price is
 *  absent (shown as "—"); one model's failure never blanks the rest. */
export async function computeFromPrices(client: OrchestratorClient): Promise<FromPrices> {
  const prices: FromPrices = {};
  const unpriced: string[] = [];
  const quotes = fromPriceQuotes();
  await pool(quotes, WHATIF_CONCURRENCY, async ({ key, version }) => {
    try {
      const cost = await trainingWhatIf(client, {
        ecosystem: version.ecosystem,
        modelVariant: version.modelVariant,
        version: version.version,
        model: version.air,
        engine: version.engine,
      });
      if (typeof cost === 'number' && cost > 0) prices[key] = Math.round(cost);
      else unpriced.push(key);
    } catch {
      unpriced.push(key);
    }
  });

  // Some catalog ecosystems aren't submittable as configured (a bad AIR, a missing modelVariant, an
  // unsupported engine). Surface it so a partial or total blackout is visible in logs.
  if (unpriced.length) {
    console.warn(
      `[training-studio] from-price whatif: ${unpriced.length}/${
        quotes.length
      } models unpriced (${unpriced.join(', ')})`
    );
  }
  return prices;
}
