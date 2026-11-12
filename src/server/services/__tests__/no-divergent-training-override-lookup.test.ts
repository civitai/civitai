import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * A trainer setting's overrides are keyed `[base][engine | 'all']`, and the two entries merge field by
 * field in `getTrainingSettingOverride`. A hand-written `overrides[base].all ?? overrides[base][engine]`
 * takes the `all` entry whole and silently drops the engine one on any base that has both; that
 * shipped in four call sites, one of them the `targetSteps` max that caps a priced run.
 */

const srcRoot = path.resolve(__dirname, '../../..');
const HELPER_FILE = path.join(srcRoot, 'components/Training/Form/TrainingParams.tsx');
// Any `x.overrides?.[base]` / `x.overrides[base]` outside the helper, so reading the entries through an
// alias (`const o = ts.overrides?.[base]; o?.all ?? o?.[engine]`) is caught at the index; plus
// `baseOverride?.all`. A destructured bare `overrides[base]` is not matched — unrelated `overrides`
// maps elsewhere in src/ use that form.
const HAND_LOOKUP = /\.overrides\??\.?\[|[oO]verrides?\??\.all\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('training setting override reads', () => {
  it('go through getTrainingSettingOverride, so no caller drops the engine entry on a base with `all`', () => {
    const offenders = sourceFiles(srcRoot)
      .filter((file) => file !== HELPER_FILE)
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, i) =>
            HAND_LOOKUP.test(line) ? `${path.relative(srcRoot, file)}:${i + 1}` : null
          )
          .filter((hit): hit is string => hit !== null)
      );
    expect(offenders).toEqual([]);
  });
});
