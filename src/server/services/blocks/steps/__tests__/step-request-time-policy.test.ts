import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { STEP_TYPE_ACCEPTABLE_POSTURES, type StepModerationPosture } from '../index';
import {
  assertPolicyAgreesWithRegistryMap,
  assertRegistryEntryAgreesWithPolicy,
  billingModeForSubmittedType,
  evaluateSubmittedStep,
  lookupStepTypePolicy,
  POLICIED_STEP_TYPES,
  postureForTextSurface,
  requiredPostureForSubmittedType,
  screenSubmittedStepResources,
  STEP_TYPE_POLICY,
} from '../request-time-policy';

// ─────────────────────────────────────────────────────────────────────────────
// The AUTHORITATIVE `$type` population, read from the generated
// `@civitai/client` types at TEST time.
//
// 🔴 WHY READ THE FILE RATHER THAN HARDCODE A LIST. The whole point of the
// policy table is that a `$type` with no row is not submittable. A hardcoded
// expectation would be a copy of the table checked against the table — it would
// pass forever and could never observe the event it exists for: the orchestrator
// spec gaining a `$type` and a regenerated client bringing it in. Reading the
// generated file makes this a real drift guard.
//
// The generated types export no runtime union of every `$type` (only individual
// `<Name>Step` aliases), which is why this is a text scan rather than an import.
// ─────────────────────────────────────────────────────────────────────────────
function generatedStepTypes(): string[] {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('@civitai/client/package.json');
  const decl = path.join(path.dirname(pkg), 'dist/generated/types.gen.d.ts');
  const src = fs.readFileSync(decl, 'utf8');
  const found = [...src.matchAll(/\$type:\s*'([^']+)'/g)].map((m) => m[1]);
  return [...new Set(found)].sort();
}

describe('request-time policy: coverage of the generated $type population', () => {
  it('reads a non-empty $type population from the generated client (POSITIVE CONTROL)', () => {
    // 🔴 THE POSITIVE CONTROL FOR THE DRIFT GUARD BELOW. The guard's reassuring
    // answer is a ZERO ("no uncovered types"), and a zero is indistinguishable
    // from a scan wired to nothing — a moved file, a changed literal style, a
    // bad regex all produce an empty list and a green test. This asserts the
    // scan actually observes types, and pins a floor well under the real count
    // so it fails on an empty/near-empty read rather than tracking the number.
    const types = generatedStepTypes();
    expect(types.length).toBeGreaterThan(30);
    // Spot-anchor a few the scan MUST see, so a regex that matches nothing
    // meaningful cannot pass the count check with garbage.
    expect(types).toContain('chatCompletion');
    expect(types).toContain('textToImage');
    expect(types).toContain('convertImage');
  });

  it('every generated $type has a policy row', () => {
    const uncovered = generatedStepTypes().filter((t) => lookupStepTypePolicy(t) === undefined);
    expect(uncovered).toEqual([]);
  });

  it('every policy row corresponds to a real generated $type (no invented rows)', () => {
    const generated = new Set(generatedStepTypes());
    const invented = POLICIED_STEP_TYPES.filter((t) => !generated.has(t));
    expect(invented).toEqual([]);
  });

  it('a row classified `none` declares no text fields, and every other row declares some', () => {
    // Pins the column that carries the PROVENANCE. A row asserting "no free
    // text" while listing text fields (or vice versa) is a self-contradicting
    // classification, and the field list is what review checks against.
    for (const [type, policy] of Object.entries(STEP_TYPE_POLICY)) {
      if (policy.textSurface === 'none') {
        expect(policy.textFields, `${type} declares 'none' but lists text fields`).toEqual([]);
      } else {
        expect(
          policy.textFields.length,
          `${type} declares '${policy.textSurface}' but lists no text fields`
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe('request-time policy: GUARD 1 — moderation posture from the submitted $type', () => {
  it('derives `textOutput` for a model-generated text type', () => {
    const d = requiredPostureForSubmittedType('chatCompletion');
    expect(d).toEqual({ ok: true, value: 'textOutput' });
  });

  it('derives `none` for a media-only type', () => {
    const d = requiredPostureForSubmittedType('convertImage');
    expect(d).toEqual({ ok: true, value: 'none' });
  });

  it('FAILS CLOSED on an unlisted $type', () => {
    const d = requiredPostureForSubmittedType('someFutureOrchestratorStep');
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('unknownStepType');
    expect(d.reason).toContain('no declared moderation policy');
  });

  it('FAILS CLOSED on a type whose text surface is an open policy question', () => {
    const d = requiredPostureForSubmittedType('modelParseMetadata');
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('undecidedTextSurface');
    expect(d.reason).toContain('open policy question');
  });

  it.each(['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty'])(
    'FAILS CLOSED on the Object.prototype key %s',
    (key) => {
      // 🔴 THE FAIL-OPEN INVERSION THIS PINS. The lookup key is a `$type` an
      // UNTRUSTED app chose. On a plain object literal `STEP_TYPE_POLICY['toString']`
      // resolves to `Object.prototype.toString` — TRUTHY — so `if (!policy)`
      // evaluates false and the submit proceeds with a function as its "policy".
      // The null prototype is what makes these read `undefined`.
      expect(lookupStepTypePolicy(key)).toBeUndefined();
      const d = requiredPostureForSubmittedType(key);
      expect(d.ok).toBe(false);
      if (d.ok) throw new Error('unreachable');
      expect(d.code).toBe('unknownStepType');
    }
  );

  it('maps every text surface to a posture, or to an explicit refusal', () => {
    expect(postureForTextSurface('none')).toBe('none');
    expect(postureForTextSurface('generatedText')).toBe('textOutput');
    // 🔴 Echoed input gets the SAME answer as generated text, deliberately.
    expect(postureForTextSurface('echoedInput')).toBe('textOutput');
    // 🔴 Not a posture — a refusal.
    expect(postureForTextSurface('undecidedNeedsDomainOwner')).toBeNull();
  });
});

describe('request-time policy: GUARD 2 — resource / AIR entitlement on the submitted input', () => {
  it('allows an input with no resource reference', () => {
    const d = screenSubmittedStepResources({
      orchestratorType: 'convertImage',
      input: { sourceImage: 'https://example.com/a.png', format: 'jpeg' },
    });
    expect(d).toEqual({ ok: true, value: 'noResourceReference' });
  });

  it('FAILS CLOSED on an AIR URN in a top-level field', () => {
    const d = screenSubmittedStepResources({
      orchestratorType: 'convertImage',
      input: { model: 'urn:air:sdxl:checkpoint:civitai:4384@128713' },
    });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('unentitledResourceReference');
  });

  it('FAILS CLOSED on an AIR URN buried DEEP in a field nobody declared', () => {
    // 🔴 THE POINT OF A DEEP SCAN. Under the pivot an app builds the whole input
    // object, so an AIR can arrive through any field — including one the
    // generated schema calls a caption. A known-field check would miss this.
    const d = screenSubmittedStepResources({
      orchestratorType: 'convertImage',
      input: {
        harmless: 'ok',
        nested: { deeper: [{ note: 'see urn:air:sdxl:lora:civitai:1@2 for details' }] },
      },
    });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('unentitledResourceReference');
  });

  it('scans a type whose generated input is NOT air-bearing (the flag must not gate the scan)', () => {
    // `chatCompletion.model` is a plain provider id, so `airBearingInput` is
    // false — but the flag describes the SCHEMA, and what arrives is an object
    // the app built. Gating the scan on the flag would trust the schema to
    // constrain the payload, which is the assumption the pivot removes.
    expect(lookupStepTypePolicy('chatCompletion')?.airBearingInput).toBe(false);
    const d = screenSubmittedStepResources({
      orchestratorType: 'chatCompletion',
      input: { model: 'gpt-4o', messages: [{ role: 'user', content: 'urn:air:flux:lora:x:1@2' }] },
    });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('unentitledResourceReference');
  });

  it('FAILS CLOSED on an unlisted $type even when the input is clean', () => {
    const d = screenSubmittedStepResources({
      orchestratorType: 'someFutureOrchestratorStep',
      input: { totally: 'fine' },
    });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('unknownStepType');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 AIR CARRIED IN AN OBJECT **KEY**.
  //
  // The scan recursed over `Object.values` only, so every case below returned
  // `{ ok: true, value: 'noResourceReference' }` and the composite gate
  // ACCEPTED the submit. This is not a contrived shape: the orchestrator's own
  // generated types prescribe it. `ImageJobParams.additionalNetworks` is
  // `{ [key: string]: ImageJobNetworkParams }` documented "Use the AIR of the
  // network as the key", and `WorkflowCost.fees` is keyed by resource AIR the
  // same way. An AIR-keyed map is the MOST likely real placement, not the least.
  //
  // Each case is paired with the value-carried equivalent as a positive control,
  // so a scan that silently stopped scanning anything at all cannot pass.
  // ───────────────────────────────────────────────────────────────────────────
  const KEY_AIR = 'urn:air:sd1:lora:civitai:1234@5678';

  it('FAILS CLOSED on the literal `additionalNetworks` AIR-keyed map shape', () => {
    const control = screenSubmittedStepResources({
      orchestratorType: 'textToImage',
      input: { additionalNetworks: { theKey: { air: KEY_AIR, strength: 1 } } },
    });
    expect(control.ok).toBe(false); // positive control: AIR in a VALUE

    const d = screenSubmittedStepResources({
      orchestratorType: 'textToImage',
      input: { additionalNetworks: { [KEY_AIR]: { strength: 1, triggerWord: 'x' } } },
    });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('unentitledResourceReference');
  });

  it('FAILS CLOSED on an AIR key at the TOP level of the input', () => {
    const d = screenSubmittedStepResources({
      orchestratorType: 'convertImage',
      input: { [KEY_AIR]: 1 },
    });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('unentitledResourceReference');
  });

  it('FAILS CLOSED on an AIR key buried in a nested / array-wrapped position', () => {
    const d = screenSubmittedStepResources({
      orchestratorType: 'convertImage',
      input: { a: { b: [{ c: { [KEY_AIR.toUpperCase()]: { strength: 0.8 } } }] } },
    });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('unentitledResourceReference');
  });

  it('FAILS CLOSED on the `WorkflowCost.fees` AIR-keyed shape', () => {
    const d = screenSubmittedStepResources({
      orchestratorType: 'convertImage',
      input: { cost: { fees: { [KEY_AIR]: 0.02 } } },
    });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('unentitledResourceReference');
  });

  it('the COMPOSITE gate rejects an AIR-keyed submit end to end', () => {
    // The full accept was the actual exposure: `evaluateSubmittedStep` returned
    // `{ ok: true, value: { posture: 'none', billingMode: 'prepaidFixed', … } }`
    // for this exact payload.
    const d = evaluateSubmittedStep({
      orchestratorType: 'convertImage',
      input: { additionalNetworks: { [KEY_AIR]: { strength: 1 } } },
    });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('unentitledResourceReference');
  });

  it('IS TOTAL — a pathologically nested input is a DECISION, not a RangeError', () => {
    // ~10 KB of `[[[[…]]]]` blows an unbounded recursion's call stack. The
    // declared contract is `PolicyDecision`, never "may throw", and
    // `evaluateSubmittedStep` does not wrap this call.
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20000; i++) deep = [deep];
    let d: ReturnType<typeof screenSubmittedStepResources>;
    expect(() => {
      d = screenSubmittedStepResources({ orchestratorType: 'convertImage', input: deep });
    }).not.toThrow();
    expect(d!.ok).toBe(false);
    if (d!.ok) throw new Error('unreachable');
    expect(d!.code).toBe('unentitledResourceReference');
  });
});

describe('request-time policy: GUARD 3 — billing mode from the submitted $type', () => {
  it('returns the established mode for the one evidenced type', () => {
    expect(billingModeForSubmittedType('convertImage')).toEqual({
      ok: true,
      value: 'prepaidFixed',
    });
  });

  it('FAILS CLOSED on a listed type with no established mode', () => {
    const d = billingModeForSubmittedType('chatCompletion');
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('billingModeNotEstablished');
    expect(d.reason).toContain('no established billing mode');
  });

  it('FAILS CLOSED on an unlisted $type', () => {
    const d = billingModeForSubmittedType('someFutureOrchestratorStep');
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('unknownStepType');
  });

  it('never reports a mode for a type the table leaves null', () => {
    // Pins the fail-closed default over the WHOLE population rather than one
    // sampled row: every row whose `billingMode` is null must reject.
    for (const [type, policy] of Object.entries(STEP_TYPE_POLICY)) {
      const d = billingModeForSubmittedType(type);
      if (policy.billingMode === null) {
        expect(d.ok, `${type} has a null mode but was accepted`).toBe(false);
      } else {
        expect(d).toEqual({ ok: true, value: policy.billingMode });
      }
    }
  });
});

describe('request-time policy: the composite gate', () => {
  it('accepts a fully-policied, clean submit', () => {
    const d = evaluateSubmittedStep({
      orchestratorType: 'convertImage',
      input: { sourceImage: 'https://example.com/a.png' },
    });
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error('unreachable');
    expect(d.value.posture).toBe('none');
    expect(d.value.billingMode).toBe('prepaidFixed');
    expect(d.value.orchestratorType).toBe('convertImage');
  });

  it('rejects on the POSTURE axis before the others', () => {
    // An undecided type with an AIR AND no billing mode: the posture rejection
    // is the one reported, which pins the documented order.
    const d = evaluateSubmittedStep({
      orchestratorType: 'modelParseMetadata',
      input: { model: 'urn:air:sdxl:checkpoint:civitai:1@2' },
    });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('undecidedTextSurface');
  });

  it('rejects on the RESOURCE axis before billing', () => {
    // `chatCompletion` derives a posture fine, has no billing mode, and here
    // carries an AIR — the resource rejection must win.
    const d = evaluateSubmittedStep({
      orchestratorType: 'chatCompletion',
      input: { model: 'urn:air:sdxl:checkpoint:civitai:1@2' },
    });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('unentitledResourceReference');
  });

  it('rejects on the BILLING axis when posture and resources both pass', () => {
    const d = evaluateSubmittedStep({
      orchestratorType: 'chatCompletion',
      input: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('billingModeNotEstablished');
  });

  it('rejects an unlisted $type on every axis', () => {
    const d = evaluateSubmittedStep({ orchestratorType: 'nope', input: {} });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('unknownStepType');
  });
});

describe('request-time policy: the table is immutable', () => {
  it('the container is frozen', () => {
    expect(Object.isFrozen(STEP_TYPE_POLICY)).toBe(true);
  });

  it('every row is frozen, and so is its textFields array', () => {
    // 🔴 A SHALLOW FREEZE WOULD LEAVE EVERY ROW MUTABLE, and `readonly` is a
    // compile-time fiction a runtime assignment walks straight through — after
    // which `chatCompletion` could be flipped to `textSurface: 'none'` and its
    // output published unscanned.
    for (const [type, policy] of Object.entries(STEP_TYPE_POLICY)) {
      expect(Object.isFrozen(policy), `${type} row not frozen`).toBe(true);
      expect(Object.isFrozen(policy.textFields), `${type} textFields not frozen`).toBe(true);
    }
  });

  it('a write to a row does not take effect', () => {
    // 🔴 THIS TEST RESTORES WHAT IT BREAKS, AND THAT IS NOT TIDINESS. Written
    // the obvious way — assign, then assert the value is unchanged — it is
    // SAFE only while the freeze works. The moment the freeze is removed the
    // assignment LANDS, and because the table is module-level it stays landed
    // for every test that runs after: a mutation sweep then shows unrelated
    // tests going red on polluted state rather than on their own guard, which
    // reads as coverage those guards do not have. Measured, not hypothesised —
    // an unfreeze mutation killed six tests, only two of them legitimately.
    const original = STEP_TYPE_POLICY.chatCompletion.textSurface;
    try {
      expect(() => {
        (STEP_TYPE_POLICY.chatCompletion as { textSurface: string }).textSurface = 'none';
      }).toThrow(); // strict mode (ESM) — a write to a frozen object throws
      expect(STEP_TYPE_POLICY.chatCompletion.textSurface).toBe('generatedText');
    } finally {
      // No-op when the freeze holds (the write never landed). Only does
      // anything when the guard under test is broken — which is exactly when
      // the isolation matters.
      if (STEP_TYPE_POLICY.chatCompletion.textSurface !== original) {
        (STEP_TYPE_POLICY.chatCompletion as { textSurface: string }).textSurface = original;
      }
    }
  });
});

describe('request-time policy: cross-check against the registry', () => {
  const goodEntry = {
    id: 'convert-image',
    orchestratorType: 'convertImage',
    moderationPosture: 'none' as StepModerationPosture,
    billingMode: 'prepaidFixed' as const,
  };

  it('accepts the shipped entry shape (THE CONTROL)', () => {
    // 🔴 THE CONTROL. If this throws, every negative case below is meaningless —
    // they would "pass" because the base shape is rejected, not because the
    // field under test is wrong.
    expect(() => assertRegistryEntryAgreesWithPolicy(goodEntry)).not.toThrow();
  });

  it('rejects an entry whose declared posture disagrees with the derived one', () => {
    expect(() =>
      assertRegistryEntryAgreesWithPolicy({
        ...goodEntry,
        moderationPosture: 'promptAudit' as StepModerationPosture,
      })
    ).toThrow(/requires 'none'/);
  });

  it('rejects an entry whose $type has no policy row', () => {
    expect(() =>
      assertRegistryEntryAgreesWithPolicy({ ...goodEntry, orchestratorType: 'notAThing' })
    ).toThrow(/no request-time policy row/);
  });

  it('rejects an entry whose declared billing mode contradicts an established one', () => {
    expect(() =>
      assertRegistryEntryAgreesWithPolicy({ ...goodEntry, billingMode: 'timeBounded' })
    ).toThrow(/establishes 'prepaidFixed'/);
  });

  it('does NOT reject an entry whose $type has no established billing mode', () => {
    // The documented asymmetry: a `null` row means "not ratified for
    // app-composed submission", which is a different question from the
    // registry's own clause-10 gate. Only a contradiction is an error.
    expect(() =>
      assertRegistryEntryAgreesWithPolicy({
        id: 'hypothetical',
        orchestratorType: 'chatCompletion',
        moderationPosture: 'textOutput' as StepModerationPosture,
        billingMode: 'prepaidFixed',
      })
    ).not.toThrow();
  });

  it('agrees with the registry posture map over its WHOLE population (THE CONTROL)', () => {
    expect(() => assertPolicyAgreesWithRegistryMap(STEP_TYPE_ACCEPTABLE_POSTURES)).not.toThrow();
  });

  it('the registry map covers more than one $type (POSITIVE CONTROL for the check above)', () => {
    // 🔴 Without this, the agreement assertion could be vacuously green over an
    // empty or single-entry map and nobody would know — the loop would simply
    // not execute. Pins that the population it walks is real.
    expect(Object.keys(STEP_TYPE_ACCEPTABLE_POSTURES).length).toBeGreaterThanOrEqual(7);
  });

  it('detects a map that licenses a $type this module refuses', () => {
    expect(() => assertPolicyAgreesWithRegistryMap({ modelParseMetadata: ['textOutput'] })).toThrow(
      /derives none/
    );
  });

  it('detects a map whose accepted postures exclude the derived one', () => {
    expect(() => assertPolicyAgreesWithRegistryMap({ chatCompletion: ['none'] })).toThrow(
      /derives posture 'textOutput'/
    );
  });

  it('detects a map naming a $type with no policy row at all', () => {
    expect(() => assertPolicyAgreesWithRegistryMap({ notAThing: ['none'] })).toThrow(
      /derives none/
    );
  });
});

describe('request-time policy: the findings this table records', () => {
  it('flags chatCompletion as BOTH text-producing and media-emitting', () => {
    // 🔴 The cross-axis case the registry's MEDIA-XOR-TEXT model cannot express.
    // `modalities: ['image']` makes this $type return images on
    // `choices[].message.images[]`, so a purely text-posture treatment hands an
    // app a media channel the text scan does not stand in front of.
    const p = lookupStepTypePolicy('chatCompletion');
    expect(p?.textSurface).toBe('generatedText');
    expect(p?.emitsMedia).toBe(true);
  });

  it('records the transcript`s SECOND copy on transcription', () => {
    expect(lookupStepTypePolicy('transcription')?.textFields).toContain('timeStamps[].text');
  });

  it('records that xGuardModeration echoes caller text back, not just modelReason', () => {
    const fields = lookupStepTypePolicy('xGuardModeration')?.textFields ?? [];
    expect(fields).toContain('results[].modelReason');
    expect(fields.some((f) => f.startsWith('results[].matchedTerms.'))).toBe(true);
  });

  it('leaves every domain-owner question unsubmittable', () => {
    const undecided = Object.entries(STEP_TYPE_POLICY)
      .filter(([, p]) => p.textSurface === 'undecidedNeedsDomainOwner')
      .map(([t]) => t);
    // There ARE open questions — a zero here would mean the classification
    // silently decided them all.
    expect(undecided.length).toBeGreaterThan(0);
    for (const type of undecided) {
      const d = requiredPostureForSubmittedType(type);
      expect(d.ok, `${type} is submittable but its classification is undecided`).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `platformDiagnosticFields` — the DRIFT GUARD, derived from the generated types
// rather than restated from the table.
//
// 🔴 WHAT WENT WRONG AND WHY A REVIEW-ONLY COLUMN WOULD NOT HAVE CAUGHT IT.
// 22 rows declared `textSurface: 'none'` + `textFields: []` — whose own
// definition is "structural strings (urls, ids, hashes) only" — while every one
// of them reached `Blob.blockedReason?: null | string`, generated doc "Get an
// optional reason for why the blob was blocked". The single row that DID record
// the field (`mediaRating`) proved the table already regarded it as text, which
// is what made the other 22 self-contradicting rather than merely terse.
//
// 🔴 THE WALK BELOW MUST FOLLOW INTERSECTION/EXTENSION TYPES, AND THAT IS THE
// SECOND HALF OF THE DEFECT. `composeMedia`'s declared `ComposeMediaOutput` is
// `{ type; elements[] }` and reaches no `Blob` at all — a one-level walk calls
// it clean. Its runtime value is `AudioComposeMediaOutput` /
// `VideoComposeMediaOutput`, both `Omit<ComposeMediaOutput,'type'> & { …Blob }`.
// A guard written without extension-awareness would therefore report
// `composeMedia` as NOT carrying the field and fail against a correct table —
// so the walk's extension handling is load-bearing, not incidental.
// ─────────────────────────────────────────────────────────────────────────────
describe('request-time policy: platformDiagnosticFields is derived, not asserted', () => {
  /** Every `export type NAME = <rhs>` in the generated declaration file. */
  function generatedDecls(): Map<string, string> {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('@civitai/client/package.json');
    const decl = path.join(path.dirname(pkg), 'dist/generated/types.gen.d.ts');
    const lines = fs.readFileSync(decl, 'utf8').split('\n');
    const out = new Map<string, string>();
    for (let i = 0; i < lines.length; i++) {
      const m = /^export type ([A-Za-z0-9_]+) = (.*)$/.exec(lines[i]);
      if (!m) continue;
      let depth = (m[2].match(/\{/g) ?? []).length - (m[2].match(/\}/g) ?? []).length;
      const buf = [m[2]];
      let j = i;
      while (depth > 0 && j + 1 < lines.length) {
        j++;
        buf.push(lines[j]);
        depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length;
      }
      out.set(m[1], buf.join('\n'));
      i = j;
    }
    return out;
  }

  const decls = generatedDecls();

  /** Named types referenced anywhere inside a declaration body. */
  function referenced(body: string): string[] {
    return [...new Set(body.replace(/'[^']*'/g, '').match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [])];
  }

  /** True when `name`, or anything it reaches, declares a `blockedReason` field. */
  const memo = new Map<string, boolean>();
  function carries(name: string, seen = new Set<string>()): boolean {
    const hit = memo.get(name);
    if (hit !== undefined) return hit;
    if (seen.has(name) || !decls.has(name)) return false;
    seen.add(name);
    const body = decls.get(name)!;
    let result = /^\s*blockedReason\??:/m.test(body);
    if (!result) {
      for (const ref of referenced(body)) {
        if (ref !== name && carries(ref, seen)) {
          result = true;
          break;
        }
      }
    }
    if (seen.size === 1) memo.set(name, result);
    return result;
  }

  /** `X & {…}` / `Omit<X,…> & {…}` types that extend `base`. */
  function extensionsOf(base: string): string[] {
    const out: string[] = [];
    for (const [name, body] of decls) {
      if (!body.includes('&')) continue;
      const head = body.split('&')[0].trim();
      if (head === base || new RegExp(`^Omit<\\s*${base}\\s*,`).test(head)) out.push(name);
    }
    return out;
  }

  function outputTypeFor(type: string): string | undefined {
    const want = `${type}output`.toLowerCase();
    for (const name of decls.keys()) if (name.toLowerCase() === want) return name;
    return undefined;
  }

  it('reads the generated declarations at all (POSITIVE CONTROL)', () => {
    // 🔴 The guard's reassuring answer is a ZERO, which a parser wired to
    // nothing produces just as readily as a correct table. Pin that the parse
    // observes real declarations, that the walk can answer BOTH ways, and that
    // extension resolution finds the `composeMedia` variants — otherwise the
    // "every row agrees" assertion below is vacuous.
    expect(decls.size).toBeGreaterThan(500);
    expect(decls.has('Blob')).toBe(true);
    expect(carries('Blob')).toBe(true); // declares it directly
    expect(carries('ImageBlob')).toBe(true); // reaches it through `Omit<Blob,'type'> & …`
    expect(carries('ConvertImageOutput')).toBe(true); // reaches it one level down
    expect(carries('ComposeMediaOutput')).toBe(false); // NEGATIVE: the declared type is clean
    expect(carries('TranscriptionOutput')).toBe(false); // NEGATIVE: no blob anywhere
    expect(extensionsOf('ComposeMediaOutput').sort()).toEqual([
      'AudioComposeMediaOutput',
      'VideoComposeMediaOutput',
    ]);
    expect(extensionsOf('VideoGenOutput')).toEqual(['HaiperVideoGenOutput']);
  });

  it('every $type whose output reaches blockedReason declares it, and no other row does', () => {
    const derived: string[] = [];
    for (const type of Object.keys(STEP_TYPE_POLICY)) {
      const out = outputTypeFor(type);
      expect(out, `no <Name>Output resolved for ${type}`).toBeDefined();
      const candidates = [out!, ...extensionsOf(out!)];
      if (candidates.some((c) => carries(c))) derived.push(type);
    }
    // A floor, so an empty derivation cannot pass as "the table is right".
    expect(derived.length).toBeGreaterThan(20);

    const declaredRows = Object.entries(STEP_TYPE_POLICY)
      .filter(([, p]) => p.platformDiagnosticFields.length > 0)
      .map(([t]) => t);
    expect(declaredRows.sort()).toEqual(derived.sort());
  });

  it('pins the paths for the cases the enumeration got wrong the first time', () => {
    // The plainest `'none'` row, and the one shipped registry entry's $type.
    expect(STEP_TYPE_POLICY.convertImage.platformDiagnosticFields).toEqual(['blob.blockedReason']);
    // Reachable ONLY through the two intersection subtypes.
    expect(STEP_TYPE_POLICY.composeMedia.platformDiagnosticFields).toEqual([
      'audioBlob.blockedReason',
      'videoBlob.blockedReason',
    ]);
    // A `null | Array<VideoBlob>` element path — the `[]` must survive the
    // `null |` prefix, which a naive `^Array<` match drops.
    expect(STEP_TYPE_POLICY.videoGen.platformDiagnosticFields).toEqual([
      'video.blockedReason',
      'additionalVideos[].blockedReason',
    ]);
    // The widest row — 13 paths across 7 optional blob slots plus a nested
    // `basicAnimations` group. A truncated walk shows up here first.
    expect(STEP_TYPE_POLICY.polyGen.platformDiagnosticFields).toHaveLength(13);
    // Three separate raw `Blob`s on one result element.
    expect(STEP_TYPE_POLICY.comfyNodepackSnapshot.platformDiagnosticFields).toEqual([
      'results[].layer.blockedReason',
      'results[].objectInfo.blockedReason',
      'results[].web.blockedReason',
    ]);
    // NEGATIVE anchors: rows whose outputs genuinely carry no blob.
    expect(STEP_TYPE_POLICY.transcription.platformDiagnosticFields).toEqual([]);
    expect(STEP_TYPE_POLICY.blobArchive.platformDiagnosticFields).toEqual([]);
    expect(STEP_TYPE_POLICY.wdTagging.platformDiagnosticFields).toEqual([]);
  });

  it('keeps the two provenance columns disjoint in meaning', () => {
    // 🔴 `blockedReason` used to live in `mediaRating.textFields` and NOWHERE
    // else, which is precisely how one field ended up called text on one row and
    // absent on 22. No row may list it as `textFields` again.
    for (const [type, p] of Object.entries(STEP_TYPE_POLICY)) {
      expect(
        p.textFields.filter((f) => f.includes('blockedReason')),
        `${type} lists blockedReason in textFields; it belongs in platformDiagnosticFields`
      ).toEqual([]);
    }
    // …and mediaRating still fails closed on its OWN merits, not on that field:
    // its remaining `textFields` are all model output.
    expect(STEP_TYPE_POLICY.mediaRating.textSurface).toBe('undecidedNeedsDomainOwner');
    expect(STEP_TYPE_POLICY.mediaRating.textFields).toContain('labels[]');
    expect(STEP_TYPE_POLICY.mediaRating.textFields).toContain('ageClassification.error');
    expect(STEP_TYPE_POLICY.mediaRating.textFields.length).toBeGreaterThan(1);
    expect(requiredPostureForSubmittedType('mediaRating').ok).toBe(false);
  });

  it('every row declares the column (it cannot be forgotten on a new row)', () => {
    for (const [type, p] of Object.entries(STEP_TYPE_POLICY)) {
      expect(Array.isArray(p.platformDiagnosticFields), `${type} missing the column`).toBe(true);
      expect(Object.isFrozen(p.platformDiagnosticFields), `${type} column not frozen`).toBe(true);
    }
  });
});

describe('request-time policy: videoGen carries a THIRD-PARTY provider message', () => {
  it('is refused rather than published, because HaiperVideoGenOutput adds `message`', () => {
    // `VideoGenStep.output` is typed `VideoGenOutput` ({ video, additionalVideos }
    // — no text), but `HaiperVideoGenOutput = VideoGenOutput & { …;
    // externalTOSViolation?; message?: null | string }` is the shape a
    // `videoGen` step with `engine: 'haiper'` produces. That `message` is the
    // provider's moderation explanation — third-party free text, the same class
    // as `modelClamScan`'s raw output, which is already undecided.
    expect(STEP_TYPE_POLICY.videoGen.textSurface).toBe('undecidedNeedsDomainOwner');
    expect(STEP_TYPE_POLICY.videoGen.textFields).toEqual(['message']);

    const d = requiredPostureForSubmittedType('videoGen');
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.code).toBe('undecidedTextSurface');

    // The whole gate refuses it, not just guard 1.
    const gate = evaluateSubmittedStep({
      orchestratorType: 'videoGen',
      input: { prompt: 'a cat' },
    });
    expect(gate.ok).toBe(false);
  });

  it('records the text fields a first pass missed on ALREADY-text rows', () => {
    // 🟡 These rows were already `generatedText` / `undecidedNeedsDomainOwner`,
    // so nothing was ever licensed by the omission — but `textFields` is the
    // column a reviewer checks a classification against and a scan would be
    // written from, and an incomplete one reads as a complete one.
    const x = STEP_TYPE_POLICY.xGuardModeration.textFields;
    // Plain `string` on `XGuardLabelResult`, no doc, no enum — `topToken` is the
    // guard model's highest-probability token.
    expect(x).toContain('results[].topToken');
    expect(x).toContain('results[].finishReason');
    expect(x).toContain('signalMetadata.customSignals[].name');

    // "Optional name for the participant", on the ASSISTANT message.
    expect(STEP_TYPE_POLICY.chatCompletion.textFields).toContain('choices[].message.name');

    // `null | string`, not numbers — nothing in the generated type bounds them.
    expect(STEP_TYPE_POLICY.audioCaptioning.textFields).toContain('results[].bpm');
    expect(STEP_TYPE_POLICY.audioCaptioning.textFields).toContain('results[].duration');

    // Four classifier labels; `aiRecognition.label` is documented as coming from
    // "the model's own id2label", so the example lists are not closed sets.
    const m = STEP_TYPE_POLICY.mediaRating.textFields;
    for (const f of [
      'ageClassification.detections[].ageLabel',
      'aiRecognition.label',
      'animeRecognition.label',
      'humanRecognition.label',
    ]) {
      expect(m, `mediaRating missing ${f}`).toContain(f);
    }

    // 🔴 `QwenImageBenchScoreNode.children: Array<QwenImageBenchScoreNode>` is
    // self-referential, so a `scores[].name` path names ONLY the root level.
    expect(STEP_TYPE_POLICY.qwenImageBench.textFields).toContain('results[].scores[]**.name');
    expect(STEP_TYPE_POLICY.qwenImageBench.textFields).not.toContain('results[].scores[].name');
  });

  it('pins the recursion that the qwenImageBench path notation stands for', () => {
    // A path string is a claim about the generated types; this checks the claim
    // rather than trusting the notation. If `children` ever stops being
    // self-referential the `**` is wrong and should come back out.
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('@civitai/client/package.json');
    const src = fs.readFileSync(
      path.join(path.dirname(pkg), 'dist/generated/types.gen.d.ts'),
      'utf8'
    );
    const decl = /export type QwenImageBenchScoreNode = \{([\s\S]*?)\n\};/.exec(src);
    expect(decl, 'QwenImageBenchScoreNode not found — the pin below proves nothing').not.toBeNull();
    expect(decl![1]).toMatch(/name:\s*string/);
    expect(decl![1]).toMatch(/children:\s*Array<QwenImageBenchScoreNode>/);
  });

  it('does not disturb the one shipped registry entry (THE CONTROL)', () => {
    // convertImage is the only registered step; the F2/F3 corrections must not
    // have made it unsubmittable.
    expect(requiredPostureForSubmittedType('convertImage')).toEqual({ ok: true, value: 'none' });
    expect(
      evaluateSubmittedStep({
        orchestratorType: 'convertImage',
        input: { sourceImage: 'https://example.com/a.png', format: 'jpeg' },
      }).ok
    ).toBe(true);
  });
});
