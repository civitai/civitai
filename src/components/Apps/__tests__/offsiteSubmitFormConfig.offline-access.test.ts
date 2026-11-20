import { describe, expect, it } from 'vitest';
import {
  emptyOffsiteSubmitForm,
  isOfflineAccessDeclaredInForm,
  pruneJustificationsToMask,
  scopeJustificationError,
  setOfflineAccessDeclared,
  shapeSensitiveJustifications,
  toSubmitExternalInput,
} from '../offsiteSubmitFormConfig';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * The offline-access declaration on the connect-listing form. It lives in `scopeJustifications`
 * under the reserved `offline_access` key (present = ticked; its text = the justification), so it
 * rides the same submit, edit-prefill, material-diff and revision paths as a sensitive scope's
 * rationale. These pin that no mask-based shaping drops it.
 */

const form = (just: Record<string, string>, scopes: bigint = TokenScope.ModelsWrite) => ({
  ...emptyOffsiteSubmitForm(),
  slug: 'photo-sync',
  name: 'Photo Sync',
  connectClientId: 'oc_1',
  requestedScopes: scopes,
  scopeJustifications: just,
});

describe('setOfflineAccessDeclared / isOfflineAccessDeclaredInForm', () => {
  it('ticking adds an empty justification; unticking removes it and its text', () => {
    const ticked = setOfflineAccessDeclared(form({}), true);
    expect(ticked.scopeJustifications).toEqual({ offline_access: '' });
    expect(isOfflineAccessDeclaredInForm(ticked)).toBe(true);
    const withText = { ...ticked, scopeJustifications: { offline_access: 'nightly sync' } };
    expect(setOfflineAccessDeclared(withText, true).scopeJustifications).toEqual({
      offline_access: 'nightly sync',
    });
    const unticked = setOfflineAccessDeclared(withText, false);
    expect(unticked.scopeJustifications).toEqual({});
    expect(isOfflineAccessDeclaredInForm(unticked)).toBe(false);
  });
});

describe('scopeJustificationError — a ticked declaration needs a reason', () => {
  it('ticked and blank → an error naming offline access', () => {
    expect(scopeJustificationError(form({ ModelsWrite: 'uploads', offline_access: '  ' }))).toBe(
      'Explain why your app needs offline access, or untick it.'
    );
  });
  it('ticked with a reason, or not ticked → no error', () => {
    expect(
      scopeJustificationError(form({ ModelsWrite: 'uploads', offline_access: 'nightly sync' }))
    ).toBeUndefined();
    expect(scopeJustificationError(form({ ModelsWrite: 'uploads' }))).toBeUndefined();
  });
});

describe('mask-based shaping keeps the declaration (it is not a scope bit)', () => {
  it('the submit payload carries it, trimmed, beside the sensitive justifications', () => {
    expect(
      toSubmitExternalInput(
        form({ ModelsWrite: 'uploads', offline_access: '  nightly sync ', ModelsRead: 'x' })
      ).scopeJustifications
    ).toEqual({ ModelsWrite: 'uploads', offline_access: 'nightly sync' });
  });
  it('pruning to a mask with no bits at all still keeps it', () => {
    expect(pruneJustificationsToMask({ offline_access: 'nightly', ModelsWrite: 'u' }, 0n)).toEqual({
      offline_access: 'nightly',
    });
  });
  it('the edit diff shaping keeps it (so changing it is a change)', () => {
    expect(shapeSensitiveJustifications({ offline_access: 'a' }, TokenScope.ModelsRead)).toEqual({
      offline_access: 'a',
    });
  });
});
