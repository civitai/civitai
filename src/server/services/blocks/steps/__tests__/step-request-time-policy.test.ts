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
