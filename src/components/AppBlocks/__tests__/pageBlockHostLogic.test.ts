import { describe, it, expect } from 'vitest';
import {
  grantedPageScopes,
  pageFallbackReason,
  resolveCheckpointPickerRequest,
  resolveResourcePickerRequest,
  PAGE_RESOURCE_PICKER_TYPES,
  type PageHostStatus,
} from '../pageBlockHostLogic';

/**
 * W10 PageBlockHost pure logic.
 *
 * #3/#6 — grantedPageScopes: the scopes the host advertises in BLOCK_INIT /
 * TOKEN_REFRESH must be the REAL granted set the JWT carries (declared −
 * missing), NOT the old hardcoded `[]`. A page token carries the viewer-scoped
 * ambient `apps:storage:*` scopes; posting `[]` lied to the block.
 *
 * #4 — pageFallbackReason: a full-page surface in a terminal state must render
 * a BlockFallback message (mapped reason), not a blank viewport.
 */

describe('grantedPageScopes (#3/#6 — BLOCK_INIT carries the JWT scopes, not [])', () => {
  it('returns the declared scopes when nothing is withheld (the real JWT scopes — NOT [])', () => {
    const declared = ['apps:storage:read', 'apps:storage:write'];
    expect(grantedPageScopes(declared, [])).toEqual(declared);
    expect(grantedPageScopes(declared, undefined)).toEqual(declared);
    // The regression we're fixing: this must NOT collapse to the old `[]`.
    expect(grantedPageScopes(declared, [])).not.toEqual([]);
  });

  it('strips the consent-withheld scopes from the granted set', () => {
    const declared = ['apps:storage:read', 'apps:storage:write', 'social:read'];
    expect(grantedPageScopes(declared, ['social:read'])).toEqual([
      'apps:storage:read',
      'apps:storage:write',
    ]);
  });

  it('returns [] only when every declared scope is withheld', () => {
    expect(grantedPageScopes(['social:read'], ['social:read'])).toEqual([]);
  });

  it('is a no-op for a missingScopes entry that was never declared', () => {
    const declared = ['apps:storage:read'];
    expect(grantedPageScopes(declared, ['ai:write:budgeted'])).toEqual(declared);
  });
});

describe('pageFallbackReason (#4 — terminal state renders a fallback, not a blank page)', () => {
  it('returns null for the non-terminal states (iframe is rendered, not a fallback)', () => {
    expect(pageFallbackReason('loading')).toBeNull();
    expect(pageFallbackReason('ready')).toBeNull();
  });

  it('maps each terminal state to a BlockFallback reason (so a failed page shows a message)', () => {
    const cases: Array<[PageHostStatus, string]> = [
      ['timeout', 'timeout'],
      ['fatal', 'fatal_block_error'],
      ['no_token', 'token_error'],
      ['error', 'token_error'],
    ];
    for (const [status, reason] of cases) {
      expect(pageFallbackReason(status)).toBe(reason);
    }
  });

  it('never returns null for a terminal failure state (no blank-viewport regression)', () => {
    for (const status of ['timeout', 'fatal', 'no_token', 'error'] as PageHostStatus[]) {
      expect(pageFallbackReason(status)).not.toBeNull();
    }
  });
});

describe('resolveResourcePickerRequest (OPEN_RESOURCE_PICKER — type allowlist + drop rules)', () => {
  it('accepts a Checkpoint request and returns the canonical type', () => {
    expect(resolveResourcePickerRequest({ requestId: 'r1', resourceType: 'Checkpoint' })).toEqual({
      requestId: 'r1',
      resourceType: 'Checkpoint',
    });
  });

  it('accepts a LoRA request (canonical LORA token)', () => {
    expect(resolveResourcePickerRequest({ requestId: 'r2', resourceType: 'LORA' })).toEqual({
      requestId: 'r2',
      resourceType: 'LORA',
    });
  });

  it('is case-insensitive on the wire but returns the canonical token', () => {
    expect(resolveResourcePickerRequest({ requestId: 'r3', resourceType: 'lora' })?.resourceType).toBe(
      'LORA'
    );
    expect(
      resolveResourcePickerRequest({ requestId: 'r4', resourceType: 'checkpoint' })?.resourceType
    ).toBe('Checkpoint');
    expect(
      resolveResourcePickerRequest({ requestId: 'r5', resourceType: '  LoRA  ' })?.resourceType
    ).toBe('LORA');
  });

  it('passes through an optional baseModelGroup family hint', () => {
    expect(
      resolveResourcePickerRequest({
        requestId: 'r6',
        resourceType: 'LORA',
        baseModelGroup: 'Flux1',
      })
    ).toEqual({ requestId: 'r6', resourceType: 'LORA', baseModelGroup: 'Flux1' });
  });

  it('omits an empty/blank baseModelGroup (no spurious family key)', () => {
    const r = resolveResourcePickerRequest({ requestId: 'r7', resourceType: 'Checkpoint', baseModelGroup: '' });
    expect(r).toEqual({ requestId: 'r7', resourceType: 'Checkpoint' });
    expect(r).not.toHaveProperty('baseModelGroup');
  });

  it('REJECTS an unsupported type (VAE / embeddings / wildcards) → null (modal never opens)', () => {
    for (const t of ['VAE', 'TextualInversion', 'Wildcards', 'Upscaler', 'LoCon', 'DoRA', 'Hypernetwork']) {
      expect(resolveResourcePickerRequest({ requestId: 'r', resourceType: t })).toBeNull();
    }
  });

  it('DROPS a request with a missing or non-string requestId', () => {
    expect(resolveResourcePickerRequest({ resourceType: 'Checkpoint' })).toBeNull();
    expect(resolveResourcePickerRequest({ requestId: '', resourceType: 'Checkpoint' })).toBeNull();
    expect(resolveResourcePickerRequest({ requestId: 42, resourceType: 'Checkpoint' })).toBeNull();
  });

  it('DROPS a request with a missing or non-string resourceType', () => {
    expect(resolveResourcePickerRequest({ requestId: 'r' })).toBeNull();
    expect(resolveResourcePickerRequest({ requestId: 'r', resourceType: 123 })).toBeNull();
    expect(resolveResourcePickerRequest({ requestId: 'r', resourceType: null })).toBeNull();
  });

  it('DROPS non-object / nullish payloads', () => {
    expect(resolveResourcePickerRequest(undefined)).toBeNull();
    expect(resolveResourcePickerRequest(null)).toBeNull();
    expect(resolveResourcePickerRequest('Checkpoint')).toBeNull();
    expect(resolveResourcePickerRequest(123)).toBeNull();
  });

  it('the v1 allowlist is exactly Checkpoint + LoRA (guards against scope creep)', () => {
    expect([...PAGE_RESOURCE_PICKER_TYPES].sort()).toEqual(['Checkpoint', 'LORA']);
  });
});

describe('resolveCheckpointPickerRequest (OPEN_CHECKPOINT_PICKER — dev:live↔prod parity)', () => {
  it('accepts a bare requestId (type is implicitly Checkpoint — no allowlist)', () => {
    expect(resolveCheckpointPickerRequest({ requestId: 'c1' })).toEqual({ requestId: 'c1' });
  });

  it('passes through an optional baseModelGroup family hint', () => {
    expect(resolveCheckpointPickerRequest({ requestId: 'c2', baseModelGroup: 'Flux1' })).toEqual({
      requestId: 'c2',
      baseModelGroup: 'Flux1',
    });
  });

  it('omits an empty/blank baseModelGroup (no spurious family key)', () => {
    const r = resolveCheckpointPickerRequest({ requestId: 'c3', baseModelGroup: '' });
    expect(r).toEqual({ requestId: 'c3' });
    expect(r).not.toHaveProperty('baseModelGroup');
  });

  it('DROPS a request with a missing or non-string requestId', () => {
    expect(resolveCheckpointPickerRequest({})).toBeNull();
    expect(resolveCheckpointPickerRequest({ requestId: '' })).toBeNull();
    expect(resolveCheckpointPickerRequest({ requestId: 42 })).toBeNull();
    expect(resolveCheckpointPickerRequest({ requestId: null })).toBeNull();
  });

  it('DROPS non-object / nullish payloads', () => {
    expect(resolveCheckpointPickerRequest(undefined)).toBeNull();
    expect(resolveCheckpointPickerRequest(null)).toBeNull();
    expect(resolveCheckpointPickerRequest('Checkpoint')).toBeNull();
    expect(resolveCheckpointPickerRequest(123)).toBeNull();
  });
});
