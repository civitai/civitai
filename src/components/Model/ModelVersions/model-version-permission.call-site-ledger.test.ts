import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../../../test/source-scan';
import { stripComments } from '../../../../test/strip-comments';

/**
 * RELATIONSHIP GUARD for where `useModelVersionPermission` gets its version from.
 *
 * Without a `modelVersion` argument the hook fetches `modelVersion.getById` itself. On the model page
 * that is a second request for a version the page already holds from `model.getById`, so every call
 * site there must hand the page's copy in. The behavioural half — that a hook fed page data issues no
 * request and still answers correctly — is pinned in `model-version-permission-page-data.test.ts`;
 * this file pins the POPULATION: the set of callers is closed, and each one either forwards page data
 * or is a component that can be opened without it (and then forwards an optional prop its model-page
 * parent fills).
 *
 * Fails on GROWTH (a new caller that silently refetches) and on SHRINK (a renamed or removed caller
 * whose entry here went stale).
 */

const ROOT = process.cwd();

const CALL_SITE_LEDGER: Record<string, string> = {
  'src/pages/models/[id]/[[...slug]].tsx':
    'model page — feeds the selected version from model.getById; never fetches.',
  'src/components/Model/ModelVersions/ModelVersionDetails.tsx':
    'model page body — feeds the version + model props it is rendered with; never fetches.',
  'src/components/Model/ModelVersions/ModelVersionDonationGoal.tsx':
    'forwards its optional modelVersion prop; ModelVersionDetails fills it on the model page.',
  'src/components/Model/ModelVersions/ModelVersionEarlyAccessPurchase.tsx':
    'forwards its optional modelVersion prop: filled when opened from the model page, absent ' +
    'when opened from the generator (the one path that still fetches).',
};

const FILES = sourceFiles(ROOT);
const CODE = new Map(
  FILES.map((f) => [f, stripComments(readFileSync(join(ROOT, f), 'utf8'))] as const)
);
const HOME = 'src/components/Model/ModelVersions/model-version.utils.ts';
const CALL_RE = /\buseModelVersionPermission\s*\(/g;
const CALLERS = FILES.filter(
  (f) => f !== HOME && new RegExp(CALL_RE.source).test(CODE.get(f)!)
).sort();

/** The argument text of every `useModelVersionPermission(...)` call in `src`. */
function callArgs(src: string): string[] {
  const out: string[] = [];
  for (const match of src.matchAll(CALL_RE)) {
    let depth = 1;
    let i = match.index! + match[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

/** `modelVersion` passed as a key (`modelVersion: x`) or shorthand (`{ modelVersion }`). */
const PASSES_MODEL_VERSION = /\bmodelVersion\b\s*[:,}]/;

describe('useModelVersionPermission call-site ledger', () => {
  it('POSITIVE CONTROL: the scan enumerates a real population and can match', () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES).toContain(HOME);
    expect(CALLERS.length).toBeGreaterThan(0);
    // The argument matcher can tell a call with page data from one without it.
    expect(PASSES_MODEL_VERSION.test(callArgs('useModelVersionPermission({ id: 1 })')[0])).toBe(
      false
    );
    expect(
      PASSES_MODEL_VERSION.test(
        callArgs('useModelVersionPermission({ modelVersionId: f(1), modelVersion })')[0]
      )
    ).toBe(true);
  });

  it('the set of production callers EXACTLY equals the ledger', () => {
    expect(CALLERS).toEqual(Object.keys(CALL_SITE_LEDGER).sort());
  });

  it('every call passes a modelVersion, so no model-page caller refetches by default', () => {
    for (const file of Object.keys(CALL_SITE_LEDGER)) {
      const args = callArgs(CODE.get(file) ?? '');
      expect(args.length, `${file} calls the hook`).toBeGreaterThan(0);
      for (const arg of args)
        expect(PASSES_MODEL_VERSION.test(arg), `${file}: useModelVersionPermission(${arg})`).toBe(
          true
        );
    }
  });

  it('ModelVersionDetails fills the forwarded prop of both children it opens on the model page', () => {
    const details = CODE.get('src/components/Model/ModelVersions/ModelVersionDetails.tsx') ?? '';

    const donationGoal = details.match(/<ModelVersionDonationGoal\b[^>]*>/)?.[0] ?? '';
    expect(donationGoal, 'renders ModelVersionDonationGoal').not.toBe('');
    expect(donationGoal).toMatch(/\bmodelVersion=/);

    const purchaseTrigger =
      details.match(/component:\s*ModelVersionEarlyAccessPurchase,\s*props:\s*\{[^}]*\}/)?.[0] ??
      '';
    expect(purchaseTrigger, 'opens ModelVersionEarlyAccessPurchase').not.toBe('');
    expect(purchaseTrigger).toMatch(PASSES_MODEL_VERSION);
  });
});
