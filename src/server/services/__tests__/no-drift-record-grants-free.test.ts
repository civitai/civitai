import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Convention guard: the prompt-drift record NEVER becomes a derivation.
 *
 * A prompt-reuse remix whose prompt drifted is recorded (`driftedImageIds` in the
 * signed token, `meta.extra.driftedFromImageIds` on the image) so the gallery can
 * say why free was refused. It travels beside the verified sources through every
 * layer \u2014 union, re-sign, upload, sanitize, the eligibility SQL \u2014 and at each one
 * a single swapped name or key would turn "drifted" into "verified" and open the
 * free remix-gallery submission. None of those swaps fails a behavioural test:
 * the SQL is mocked, and the re-sign and upload sites have no harness.
 *
 * So each site is pinned to the name that belongs there.
 */

const SRC = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const between = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  expect(i, `${start} not found`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  return src.slice(i, j === -1 ? undefined : j);
};

describe('the drift record never grants a free submission', () => {
  it('reads the submit gate and the eligibility verdict from the verified key only', () => {
    const src = read('services/remix-gallery.service.ts');

    expect(src).toMatch(
      /const sourceImageIdsSql = \(alias = 'i'\) => extraIdArraySql\('sourceImageIds', alias\);/
    );
    expect(src).toMatch(
      /const driftedFromImageIdsSql = \(alias = 'i'\) =>\s*extraIdArraySql\('driftedFromImageIds', alias\);/
    );

    const load = between(src, 'async function loadSubmissionImage(', '\n}\n');
    expect(load).toContain('${sourceImageIdsSql()} AS "sourceImageIds"');
    expect(load).not.toContain('driftedFromImageIdsSql');
    expect(src).toContain(
      'const derivedFromHost = submission.sourceImageIds?.includes(hostImageId)'
    );

    expect(src).toContain('${hostImageId} = ANY(${sourceImageIdsSql()}) AS verified');
    // One reader: the eligibility listing, where it only changes the wording.
    expect(src.match(/driftedFromImageIdsSql\(\)/g) ?? []).toHaveLength(1);
  });

  it('keeps the two lists apart where the submit unions and re-signs them', () => {
    const provenance = read('services/orchestrator/remix-provenance.ts');
    expect(provenance).toMatch(/\.\.\.fromTokens, \.\.\.fromPrompt\.derived\]/);
    expect(provenance).not.toMatch(/new Set\(\[[^\]]*fromPrompt\.drifted/);

    const submit = read('services/orchestrator/orchestration-new.service.ts');
    const sign = between(submit, 'signProvenance({', '})');
    expect(sign).toMatch(/sourceImageIds: sourceImageIds \?\? \[\],/);
    expect(sign).toMatch(/\bdriftedImageIds,/);
    expect(sign).not.toMatch(/sourceImageIds:[^,\n]*driftedImageIds/);
  });

  it('keeps the two lists apart on upload and at the write sink', () => {
    const post = read('services/post.service.ts');
    expect(post).toMatch(
      /\{\s*sourceImageIds: verifiedSourceImageIds,\s*driftedImageIds: verifiedDriftedImageIds\s*\}/
    );
    expect(post).not.toMatch(/verifiedSourceImageIds:\s*verifiedDriftedImageIds/);

    const image = read('services/image.service.ts');
    expect(image).toMatch(/verifiedSourceImageIds,\s*verifiedDriftedImageIds\s*\)/);

    const sanitize = between(
      read('services/orchestrator/remix-provenance.ts'),
      'export function sanitizeProvenance',
      '\n}\n'
    );
    expect(sanitize).toContain('{ sourceImageIds: verified }');
    expect(sanitize).toContain('{ driftedFromImageIds: drifted }');
  });

  /**
   * Not a grant, but the same family: the reuse-prompt token must ride only while
   * its remix claim is fresh, or a later hand-typed prompt that happens to clear
   * the threshold spends a click made hours ago.
   */
  it.each([
    'components/generation_v2/FormFooter.tsx',
    'components/form-graph/generation/FormFooter.tsx',
  ])('%s sends the prompt token only with a fresh remix claim', (rel) => {
    expect(read(`../${rel}`)).toContain(
      'remixStore.getData() ? remixProvenanceStore.getPromptToken() : undefined'
    );
  });
});
