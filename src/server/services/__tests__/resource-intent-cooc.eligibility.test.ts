import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { COOC_ELIGIBLE_REST } from '~/server/services/resource-intent-cooc/build';

/**
 * The index trains on the images the M3 registration calls eligible. Its fragment must stay
 * byte-identical to `GOLDSET_ELIGIBLE_IMAGE` after that fragment's rolling-window line — the
 * extraction is the offline screen's own run-time check.
 */
const REGISTRATION = join(process.cwd(), 'scripts/eval-resource-intent-registration.ts');
const HEAD =
  'const GOLDSET_ELIGIBLE_IMAGE = (days: number) => Prisma.sql`\n      i."createdAt" > now() - make_interval(days => ${days}::int)\n';

function registrationRest(src: string): string | null {
  const i = src.indexOf(HEAD);
  const j = i < 0 ? -1 : src.indexOf('`;', i + HEAD.length);
  return i < 0 || j < 0 ? null : src.slice(i + HEAD.length, j);
}

describe('cooc eligibility fragment', () => {
  const src = readFileSync(REGISTRATION, 'utf8');

  it("is byte-identical to the registration's GOLDSET_ELIGIBLE_IMAGE after its window line", () => {
    const rest = registrationRest(src);
    expect(rest).not.toBeNull();
    expect(rest).toBe(COOC_ELIGIBLE_REST);
    expect(COOC_ELIGIBLE_REST.length).toBe(628);
  });

  it('the comparison sees a one-byte change in the registration (negative control)', () => {
    const changed = src.replace('AND i.poi = false', 'AND i.poi = falsE');
    expect(changed).not.toBe(src);
    expect(registrationRest(changed)).not.toBe(COOC_ELIGIBLE_REST);
  });
});
