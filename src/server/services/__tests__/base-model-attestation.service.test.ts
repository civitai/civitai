import { describe, expect, it } from 'vitest';
import {
  BASE_MODEL_ATTESTATION_STATEMENT,
  BASE_MODEL_ATTESTATION_VERSION,
  buildBaseModelAttestation,
  hasBaseModelAttestation,
  readBaseModelAttestation,
  requiresBaseModelAttestation,
} from '~/shared/constants/base-model-attestation.constants';
import {
  assertBaseModelAttestations,
  assertNoUnattestedScopeEntry,
  resolveBaseModelAttestation,
} from '~/server/services/base-model-attestation.service';

const H3 = 'MiniMax H3';
const OWNER_ID = 7;
const MOD_ID = 99;
const attested = (userId = OWNER_ID, baseModel = H3) => ({
  baseModelAttestation: buildBaseModelAttestation(userId, baseModel),
});
const version = (overrides: Record<string, unknown> = {}) => ({
  baseModel: H3,
  publishedAt: null as Date | null,
  meta: {} as unknown,
  model: { type: 'LORA', userId: OWNER_ID },
  ...overrides,
});

describe('requiresBaseModelAttestation', () => {
  it.each(['LORA', 'LoCon', 'DoRA', 'Checkpoint'])('covers H3 %s', (modelType) => {
    expect(requiresBaseModelAttestation({ baseModel: H3, modelType })).toBe(true);
  });

  it.each(['Workflows', 'Wildcards', 'VAE', 'TextEncoder', 'Other'])(
    'leaves H3 %s alone',
    (modelType) => {
      expect(requiresBaseModelAttestation({ baseModel: H3, modelType })).toBe(false);
    }
  );

  it('leaves other base models alone', () => {
    expect(requiresBaseModelAttestation({ baseModel: 'SDXL 1.0', modelType: 'LORA' })).toBe(false);
  });
});

describe('readBaseModelAttestation / hasBaseModelAttestation', () => {
  it('stores the statement verbatim with its version', () => {
    expect(readBaseModelAttestation(attested())).toEqual({
      userId: OWNER_ID,
      affirmedAt: expect.any(String),
      version: BASE_MODEL_ATTESTATION_VERSION,
      statement: BASE_MODEL_ATTESTATION_STATEMENT,
      baseModel: H3,
    });
  });

  it('reads a half-formed record as absent', () => {
    const { statement: _, ...partial } = attested().baseModelAttestation;
    expect(readBaseModelAttestation({ baseModelAttestation: partial })).toBeNull();
  });

  it('does not count a record from a previous owner, base model or wording', () => {
    expect(hasBaseModelAttestation(attested(), { baseModel: H3, ownerId: OWNER_ID })).toBe(true);
    expect(hasBaseModelAttestation(attested(MOD_ID), { baseModel: H3, ownerId: OWNER_ID })).toBe(
      false
    );
    expect(
      hasBaseModelAttestation(attested(OWNER_ID, 'Other'), { baseModel: H3, ownerId: OWNER_ID })
    ).toBe(false);
    const old = {
      baseModelAttestation: { ...attested().baseModelAttestation, version: 0 },
    };
    expect(hasBaseModelAttestation(old, { baseModel: H3, ownerId: OWNER_ID })).toBe(false);
  });
});

describe('assertBaseModelAttestations', () => {
  it('refuses a never-public H3 LoRA without the attestation', () => {
    expect(() => assertBaseModelAttestations({ versions: [version()] })).toThrowError(
      /right to train and share/
    );
  });

  it('passes it with the attestation', () => {
    expect(() =>
      assertBaseModelAttestations({ versions: [version({ meta: attested() })] })
    ).not.toThrow();
  });

  it('passes a non-H3 LoRA without one', () => {
    expect(() =>
      assertBaseModelAttestations({ versions: [version({ baseModel: 'SDXL 1.0' })] })
    ).not.toThrow();
  });

  it('grandfathers a version that has already been public', () => {
    expect(() =>
      assertBaseModelAttestations({
        versions: [version({ publishedAt: new Date('2026-09-01') })],
      })
    ).not.toThrow();
  });

  it('does not grandfather a version only scheduled for the future', () => {
    expect(() =>
      assertBaseModelAttestations({
        versions: [version({ publishedAt: new Date(Date.now() + 86_400_000) })],
      })
    ).toThrowError(/right to train and share/);
  });

  it('does not grandfather when going public from private', () => {
    expect(() =>
      assertBaseModelAttestations({
        versions: [version({ publishedAt: new Date('2026-09-01') })],
        grandfatherPublished: false,
      })
    ).toThrowError(/right to train and share/);
  });

  it('refuses when any one of several versions is missing it', () => {
    expect(() =>
      assertBaseModelAttestations({
        versions: [version({ meta: attested() }), version()],
      })
    ).toThrowError(/right to train and share/);
  });
});

describe('assertNoUnattestedScopeEntry', () => {
  const published = new Date('2026-09-01');

  it('refuses switching a published version to H3 without the attestation', () => {
    expect(() =>
      assertNoUnattestedScopeEntry({
        before: { baseModel: 'SDXL 1.0', modelType: 'LORA', publishedAt: published },
        after: { baseModel: H3, modelType: 'LORA', status: 'Published', meta: {} },
        ownerId: OWNER_ID,
      })
    ).toThrowError(/right to train and share/);
  });

  it('refuses it for an unpublished one too, which a republish would otherwise grandfather', () => {
    expect(() =>
      assertNoUnattestedScopeEntry({
        before: { baseModel: 'SDXL 1.0', modelType: 'LORA', publishedAt: published },
        after: { baseModel: H3, modelType: 'LORA', status: 'Unpublished', meta: {} },
        ownerId: OWNER_ID,
      })
    ).toThrowError(/right to train and share/);
  });

  it('refuses a published H3 version whose model type moves into scope', () => {
    expect(() =>
      assertNoUnattestedScopeEntry({
        before: { baseModel: H3, modelType: 'Workflows', publishedAt: published },
        after: { baseModel: H3, modelType: 'LORA', status: 'Published', meta: {} },
        ownerId: OWNER_ID,
      })
    ).toThrowError(/right to train and share/);
  });

  it('refuses creating a version straight into Published without one', () => {
    expect(() =>
      assertNoUnattestedScopeEntry({
        after: { baseModel: H3, modelType: 'LORA', status: 'Published', meta: {} },
        ownerId: OWNER_ID,
      })
    ).toThrowError(/right to train and share/);
  });

  it('lets a draft switch, since publishing it is gated', () => {
    expect(() =>
      assertNoUnattestedScopeEntry({
        before: { baseModel: 'SDXL 1.0', modelType: 'LORA', publishedAt: null },
        after: { baseModel: H3, modelType: 'LORA', status: 'Draft', meta: {} },
        ownerId: OWNER_ID,
      })
    ).not.toThrow();
  });

  it('leaves an already-in-scope grandfathered version alone', () => {
    expect(() =>
      assertNoUnattestedScopeEntry({
        before: { baseModel: H3, modelType: 'LORA', publishedAt: published },
        after: { baseModel: H3, modelType: 'LORA', status: 'Published', meta: {} },
        ownerId: OWNER_ID,
      })
    ).not.toThrow();
  });

  it('lets the switch through with the attestation', () => {
    expect(() =>
      assertNoUnattestedScopeEntry({
        before: { baseModel: 'SDXL 1.0', modelType: 'LORA', publishedAt: published },
        after: { baseModel: H3, modelType: 'LORA', status: 'Published', meta: attested() },
        ownerId: OWNER_ID,
      })
    ).not.toThrow();
  });
});

describe('resolveBaseModelAttestation', () => {
  const base = { ownerId: OWNER_ID, baseModel: H3, modelType: 'LORA' };

  it('records the owner’s attestation', () => {
    expect(resolveBaseModelAttestation({ ...base, actorId: OWNER_ID, attested: true })).toEqual(
      expect.objectContaining({ userId: OWNER_ID, baseModel: H3 })
    );
  });

  it('refuses a moderator attesting on someone else’s model', () => {
    expect(() =>
      resolveBaseModelAttestation({ ...base, actorId: MOD_ID, attested: true })
    ).toThrowError(/owner/);
  });

  it('records nothing when not ticked, out of scope, or already on record', () => {
    expect(resolveBaseModelAttestation({ ...base, actorId: OWNER_ID })).toBeUndefined();
    expect(
      resolveBaseModelAttestation({
        ...base,
        baseModel: 'SDXL 1.0',
        actorId: OWNER_ID,
        attested: true,
      })
    ).toBeUndefined();
    expect(
      resolveBaseModelAttestation({
        ...base,
        actorId: OWNER_ID,
        attested: true,
        existingMeta: attested(),
      })
    ).toBeUndefined();
  });
});
