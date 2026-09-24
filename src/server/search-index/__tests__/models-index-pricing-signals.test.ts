import { ModelVersionPricingSignal } from '@civitai/buzz';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const S = ModelVersionPricingSignal;

/**
 * `transformData` is module-private and its real signature needs a Prisma payload, five caches and a
 * live DB, so these facts are pinned textually rather than by building a document.
 *
 * Reverting the one line that writes `versions[].pricing` printed nothing before this file existed,
 * and the failure it ships is silent rather than a 5xx: every document lacking the attribute means
 * "Hide paid" matches zero models and the picker returns an empty grid.
 */
const indexSource = fs.readFileSync(
  path.join(process.cwd(), 'src/server/search-index/models.search-index.ts'),
  'utf8'
);

describe('models search index writes versions[].pricing', () => {
  it('the per-version map is built from the shared signal helper', () => {
    expect(indexSource).toMatch(/pricing:\s*modelVersionPricingSignals\(/);
  });

  it('the signals are fed the PER-VERSION gate, keyed by that version', () => {
    // The model-level rollup beside it in `transformData` cannot answer this — it keeps only a
    // deadline, so wiring it here would price every version of a model identically.
    expect(indexSource).toMatch(/paidAccessTerms\.get\(x\.id\)/);
    expect(indexSource).toMatch(/getModelVersionPaidAccessTerms\(versionIds\)/);
  });

  it('the gate query shares the live-gate predicate rather than restating it', () => {
    const service = fs.readFileSync(
      path.join(process.cwd(), 'src/server/services/paid-access.service.ts'),
      'utf8'
    );
    const fn = service.slice(
      service.indexOf('export async function getModelVersionPaidAccessTerms')
    );
    expect(fn).toMatch(/\$\{paidAccessLiveSql\}/);
    // The predicate scopes on `mv.status`, so the query does not compile without this join.
    expect(fn).toMatch(/JOIN "ModelVersion" mv ON mv\.id = pa\."entityId"/);
    // `terms` is the whole reason this exists next to the rollup; selecting only endsAt would make
    // every gated version read the same.
    expect(fn).toMatch(/SELECT[^;]*pa\.terms/);
  });

  it('the ordinals the index writes are the ones the filter reads', () => {
    // Both sides import the enum, so this pins the wire values a backfilled document carries —
    // renumbering is a backfill, and the enum's own comment says so.
    expect(S.Free).toBe(0);
    expect(S.PayToGenerate).toBe(1);
    expect(S.PayToDownload).toBe(2);
    expect(S.GenerationFree).toBe(3);
  });
});
