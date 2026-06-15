import { describe, it, expect } from 'vitest';
import { isValidRapid, isInvalidRapid, isInvalidAiToolkit } from '~/utils/training';

/**
 * Unit coverage for the training engine/base-model compatibility guards.
 *
 * These pure helpers gate which (baseModel, engine) pairings are valid before a
 * training run is dispatched. They're the deterministic, regression-prone core of
 * the "train a LoRA" flow — the full submit (Buzz + external GPU + async webhook
 * completion) is NOT preview-e2e-able (see the e2e-coverage scoping), so this is
 * the right layer to cover the validation logic. No infra, no mocking.
 */

describe('isValidRapid', () => {
  it('accepts the Flux1 rapid engine', () => {
    expect(isValidRapid('flux', 'rapid')).toBe(true);
  });

  it('accepts the Flux2 rapid-like engines only for flux2', () => {
    expect(isValidRapid('flux2', 'flux2-dev')).toBe(true);
    expect(isValidRapid('flux2', 'flux2-dev-edit')).toBe(true);
  });

  it('rejects rapid for a non-Flux1 base model', () => {
    expect(isValidRapid('sdxl', 'rapid')).toBe(false);
    expect(isValidRapid('sd15', 'rapid')).toBe(false);
  });

  it('rejects a Flux2 engine paired with a non-flux2 base model', () => {
    expect(isValidRapid('flux', 'flux2-dev')).toBe(false);
  });

  it('rejects ordinary engines (not a rapid path)', () => {
    expect(isValidRapid('flux', 'kohya')).toBe(false);
    expect(isValidRapid('sdxl', 'ai-toolkit')).toBe(false);
  });
});

describe('isInvalidRapid', () => {
  it('flags the rapid engine on any non-Flux1 base model', () => {
    expect(isInvalidRapid('sdxl', 'rapid')).toBe(true);
    expect(isInvalidRapid('flux2', 'rapid')).toBe(true);
  });

  it('allows the rapid engine on Flux1', () => {
    expect(isInvalidRapid('flux', 'rapid')).toBe(false);
  });

  it('flags Flux2 engines on a non-flux2 base model', () => {
    expect(isInvalidRapid('sd15', 'flux2-dev')).toBe(true);
    expect(isInvalidRapid('flux', 'flux2-dev-edit')).toBe(true);
  });

  it('allows Flux2 engines on flux2', () => {
    expect(isInvalidRapid('flux2', 'flux2-dev')).toBe(false);
    expect(isInvalidRapid('flux2', 'flux2-dev-edit')).toBe(false);
  });

  it('does not flag ordinary engines (no rapid/flux2 constraint)', () => {
    expect(isInvalidRapid('flux', 'kohya')).toBe(false);
    expect(isInvalidRapid('sdxl', 'musubi')).toBe(false);
  });
});

describe('isInvalidAiToolkit', () => {
  it('flags ai-toolkit on a base model it does not support (flux2)', () => {
    // isAiToolkitSupported excludes flux2 (it only uses the rapid-like engines).
    expect(isInvalidAiToolkit('flux2', 'ai-toolkit')).toBe(true);
  });

  it('allows ai-toolkit on supported base models', () => {
    expect(isInvalidAiToolkit('sdxl', 'ai-toolkit')).toBe(false);
    expect(isInvalidAiToolkit('flux', 'ai-toolkit')).toBe(false);
  });

  it('never flags when the engine is not ai-toolkit', () => {
    expect(isInvalidAiToolkit('flux2', 'rapid')).toBe(false);
    expect(isInvalidAiToolkit('sdxl', 'kohya')).toBe(false);
  });
});
