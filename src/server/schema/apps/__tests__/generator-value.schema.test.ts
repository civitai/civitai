import { describe, expect, it } from 'vitest';
import {
  generatorValueSchema,
  collectGeneratorVersionIds,
  collectGeneratorText,
  GEN_NAME_MAX,
  GEN_MAX_BUTTONS,
  GEN_MAX_LORAS_PER_BUTTON,
  GEN_PROMPT_TEMPLATE_MAX,
  type GeneratorValue,
} from '../generator-value.schema';

/**
 * Pure Zod coverage for the structured "published generator" value (Custom
 * Generators PR-B). Proves the schema ACCEPTS a well-formed generator and
 * REJECTS every oversized / out-of-range field, so an untrusted iframe value
 * can't smuggle an unbounded payload into shared_kv.
 */

function validButton(over: Record<string, unknown> = {}) {
  return {
    label: 'Anime',
    workflowType: 'textToImage',
    checkpointVersionId: 100,
    loras: [{ versionId: 200, weight: 0.8 }],
    promptTemplate: 'masterpiece, {subject}',
    params: { steps: 25, cfgScale: 7, quantity: 1 },
    exposedInputs: { prompt: true },
    ...over,
  };
}

function validGenerator(over: Record<string, unknown> = {}) {
  return {
    name: 'My Generator',
    description: 'makes nice pictures',
    buttons: [validButton()],
    backgroundImageRef: '12345',
    ...over,
  };
}

describe('generatorValueSchema — accepts a valid generator', () => {
  it('parses a full valid generator', () => {
    const parsed = generatorValueSchema.parse(validGenerator());
    expect(parsed.name).toBe('My Generator');
    expect(parsed.buttons).toHaveLength(1);
    expect(parsed.buttons[0].loras[0].weight).toBe(0.8);
    expect(parsed.backgroundImageRef).toBe('12345');
  });

  it('applies defaults (loras=[], promptTemplate="", quantity=1, exposedInputs={})', () => {
    const parsed = generatorValueSchema.parse({
      name: 'Minimal',
      buttons: [
        {
          label: 'Go',
          workflowType: 'textToImage',
          checkpointVersionId: 1,
          params: {},
        },
      ],
    });
    expect(parsed.buttons[0].loras).toEqual([]);
    expect(parsed.buttons[0].promptTemplate).toBe('');
    expect(parsed.buttons[0].params.quantity).toBe(1);
    expect(parsed.buttons[0].exposedInputs).toEqual({});
    expect(parsed.description).toBeUndefined();
    expect(parsed.backgroundImageRef).toBeUndefined();
  });
});

describe('generatorValueSchema — rejects oversized / out-of-range fields', () => {
  it('rejects an empty buttons array', () => {
    expect(generatorValueSchema.safeParse(validGenerator({ buttons: [] })).success).toBe(false);
  });

  it('rejects too many buttons', () => {
    const buttons = Array.from({ length: GEN_MAX_BUTTONS + 1 }, () => validButton());
    expect(generatorValueSchema.safeParse(validGenerator({ buttons })).success).toBe(false);
  });

  it('rejects an oversized name', () => {
    expect(
      generatorValueSchema.safeParse(validGenerator({ name: 'x'.repeat(GEN_NAME_MAX + 1) })).success
    ).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(generatorValueSchema.safeParse(validGenerator({ name: '' })).success).toBe(false);
  });

  it('rejects too many loras on a button', () => {
    const loras = Array.from({ length: GEN_MAX_LORAS_PER_BUTTON + 1 }, (_, i) => ({
      versionId: i + 1,
      weight: 1,
    }));
    expect(
      generatorValueSchema.safeParse(validGenerator({ buttons: [validButton({ loras })] })).success
    ).toBe(false);
  });

  it('rejects a lora weight above the max (2)', () => {
    expect(
      generatorValueSchema.safeParse(
        validGenerator({ buttons: [validButton({ loras: [{ versionId: 1, weight: 2.5 }] })] })
      ).success
    ).toBe(false);
  });

  it('rejects a lora weight below the min (-1)', () => {
    expect(
      generatorValueSchema.safeParse(
        validGenerator({ buttons: [validButton({ loras: [{ versionId: 1, weight: -2 }] })] })
      ).success
    ).toBe(false);
  });

  it('rejects a non-positive checkpointVersionId', () => {
    expect(
      generatorValueSchema.safeParse(validGenerator({ buttons: [validButton({ checkpointVersionId: 0 })] }))
        .success
    ).toBe(false);
  });

  it('rejects an unknown workflowType', () => {
    expect(
      generatorValueSchema.safeParse(validGenerator({ buttons: [validButton({ workflowType: 'video' })] }))
        .success
    ).toBe(false);
  });

  it('rejects an oversized promptTemplate', () => {
    expect(
      generatorValueSchema.safeParse(
        validGenerator({
          buttons: [validButton({ promptTemplate: 'x'.repeat(GEN_PROMPT_TEMPLATE_MAX + 1) })],
        })
      ).success
    ).toBe(false);
  });

  it('rejects params.steps above the cap (50)', () => {
    expect(
      generatorValueSchema.safeParse(
        validGenerator({ buttons: [validButton({ params: { steps: 51 } })] })
      ).success
    ).toBe(false);
  });

  it('rejects out-of-range dimensions', () => {
    expect(
      generatorValueSchema.safeParse(
        validGenerator({ buttons: [validButton({ params: { width: 4096 } })] })
      ).success
    ).toBe(false);
  });

  it('rejects a non-numeric backgroundImageRef', () => {
    expect(generatorValueSchema.safeParse(validGenerator({ backgroundImageRef: 'abc' })).success).toBe(
      false
    );
    expect(
      generatorValueSchema.safeParse(validGenerator({ backgroundImageRef: '12; DROP TABLE' })).success
    ).toBe(false);
  });
});

describe('collector helpers', () => {
  it('collectGeneratorVersionIds de-dupes checkpoints + loras across buttons', () => {
    const gen = generatorValueSchema.parse(
      validGenerator({
        buttons: [
          validButton({ checkpointVersionId: 100, loras: [{ versionId: 200, weight: 1 }] }),
          validButton({ checkpointVersionId: 100, loras: [{ versionId: 300, weight: 1 }] }),
        ],
      })
    ) as GeneratorValue;
    expect(collectGeneratorVersionIds(gen).sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it('collectGeneratorText gathers name, description, and non-empty promptTemplates', () => {
    const gen = generatorValueSchema.parse(
      validGenerator({
        name: 'N',
        description: 'D',
        buttons: [validButton({ promptTemplate: 'P1' }), validButton({ promptTemplate: '' })],
      })
    ) as GeneratorValue;
    expect(collectGeneratorText(gen)).toEqual(['N', 'D', 'P1']);
  });
});
