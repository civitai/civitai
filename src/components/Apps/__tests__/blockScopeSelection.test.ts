import { describe, expect, test } from 'vitest';
import {
  buildScopeJustifications,
  buildScopeOptions,
  KNOWN_BLOCK_SCOPES,
  toggleScope,
} from '~/components/Apps/blockScopeSelection';
import {
  isKnownBlockScope,
  isSensitiveBlockScope,
} from '~/shared/constants/block-scope.constants';

/**
 * Pure state logic for the App-manifest BlockScopeSelector. This is the
 * AUTHORITATIVE gate for the scope-editor behaviour (the browser test is
 * report-only). Deferred target slots are no longer edited here — the form OMITS
 * `targets` from the save patch so the server preserves `stored.targets` (asserted
 * in ManifestEditForm.browser.test.tsx), so there is no pure helper to test.
 */

describe('buildScopeOptions', () => {
  test('lists every known scope with its sensitive flag derived from the registry', () => {
    const options = buildScopeOptions([]);
    // One option per known scope (nothing selected → no extra legacy rows).
    expect(options.map((o) => o.scope)).toEqual(KNOWN_BLOCK_SCOPES);
    for (const opt of options) {
      expect(opt.known).toBe(true);
      // Sensitive flag is derived from the registry, not hardcoded.
      expect(opt.sensitive).toBe(isSensitiveBlockScope(opt.scope));
    }
  });

  test('a sensitive scope (ai:write:budgeted) is flagged sensitive', () => {
    const opt = buildScopeOptions([]).find((o) => o.scope === 'ai:write:budgeted');
    expect(opt?.sensitive).toBe(true);
  });

  test('a non-sensitive scope (user:read:self) is not flagged sensitive', () => {
    const opt = buildScopeOptions([]).find((o) => o.scope === 'user:read:self');
    expect(opt?.sensitive).toBe(false);
  });

  test('preserves an UNKNOWN/legacy selected scope as a selectable (removable) option', () => {
    const legacy = 'media:read:owned'; // retired scope no longer in the registry
    expect(isKnownBlockScope(legacy)).toBe(false);
    const options = buildScopeOptions([legacy]);
    const legacyOpt = options.find((o) => o.scope === legacy);
    expect(legacyOpt).toBeDefined();
    expect(legacyOpt?.known).toBe(false);
    // It is APPENDED, not injected into the known list.
    expect(options.filter((o) => o.known).map((o) => o.scope)).toEqual(KNOWN_BLOCK_SCOPES);
  });

  test('does not duplicate a legacy scope that appears twice in the selection', () => {
    const legacy = 'totally:made:up';
    const options = buildScopeOptions([legacy, legacy]);
    expect(options.filter((o) => o.scope === legacy)).toHaveLength(1);
  });

  test('does not append a KNOWN selected scope a second time', () => {
    const known = KNOWN_BLOCK_SCOPES[0];
    const options = buildScopeOptions([known]);
    expect(options.filter((o) => o.scope === known)).toHaveLength(1);
  });
});

describe('toggleScope', () => {
  test('adds a scope when checked, preserving order', () => {
    expect(toggleScope(['a', 'b'], 'c', true)).toEqual(['a', 'b', 'c']);
  });

  test('removes a scope when unchecked', () => {
    expect(toggleScope(['a', 'b', 'c'], 'b', false)).toEqual(['a', 'c']);
  });

  test('checking an already-selected scope is a no-op (no duplicate)', () => {
    expect(toggleScope(['a', 'b'], 'a', true)).toEqual(['a', 'b']);
  });

  test('unchecking a not-selected scope is a no-op', () => {
    expect(toggleScope(['a', 'b'], 'z', false)).toEqual(['a', 'b']);
  });
});

describe('buildScopeJustifications (deselect drops justification)', () => {
  const justifications = {
    'models:read:self': '  We show the page model.  ',
    'user:read:self': 'We greet the viewer.',
    'buzz:read:self': 'orphaned rationale',
  };

  test('keeps trimmed, non-empty justifications for SELECTED scopes only', () => {
    const out = buildScopeJustifications(['models:read:self', 'user:read:self'], justifications);
    expect(out).toEqual({
      'models:read:self': 'We show the page model.',
      'user:read:self': 'We greet the viewer.',
    });
  });

  test('deselecting a scope drops its justification from the payload', () => {
    // buzz:read:self is NOT selected → its justification is not submitted.
    const out = buildScopeJustifications(['models:read:self'], justifications);
    expect(out).not.toHaveProperty('buzz:read:self');
    expect(out).toEqual({ 'models:read:self': 'We show the page model.' });
  });

  test('a selected scope with a blank/whitespace justification is omitted', () => {
    const out = buildScopeJustifications(['models:read:self'], { 'models:read:self': '   ' });
    expect(out).toEqual({});
  });

  test('no selected scopes → empty map', () => {
    expect(buildScopeJustifications([], justifications)).toEqual({});
  });
});
