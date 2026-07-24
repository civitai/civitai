import { describe, expect, it } from 'vitest';

import {
  deriveScopesFromClient,
  emptyOffsiteSubmitForm,
  isClientStepComplete,
  isCreateDetailsStepComplete,
  isCreateUrlStepComplete,
  missingSensitiveJustifications,
  partitionScopesBySensitivity,
  pruneJustificationsToMask,
  scopeJustificationError,
  shapeScopeJustifications,
  shapeSensitiveJustifications,
  toSubmitExternalInput,
  validateConnectFields,
  validateExternalCreateForm,
  type OffsiteSubmitFormValues,
} from '~/components/Apps/offsiteSubmitFormConfig';
import { SCOPE_JUSTIFICATION_MAX_LENGTH, TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * W13 external-app submit form CONFIG — the OAuth-client (connect) FIELDS on the
 * MERGED `offsiteSubmitFormConfig` (client-side mirror). Pure view-model — no DOM.
 * Re-homed from the deleted standalone `connectSubmitFormConfig` tests. Covers the
 * scope toggle + prune, the subset gating, the create-form validation and the payload
 * shaping (omit empty / non-requested justifications; optional homepage URL).
 */

const CEILING = TokenScope.UserRead | TokenScope.ModelsRead | TokenScope.ModelsWrite; // 13

function full(overrides: Partial<OffsiteSubmitFormValues> = {}): OffsiteSubmitFormValues {
  return {
    ...emptyOffsiteSubmitForm(),
    connectClientId: 'oauth-client-1',
    slug: 'connect-app',
    name: 'Connect App',
    ...overrides,
  };
}

describe('deriveScopesFromClient', () => {
  it('sets requestedScopes to EXACTLY the client allowedScopes (auto-derived, no picking)', () => {
    const v = deriveScopesFromClient(emptyOffsiteSubmitForm(), CEILING);
    expect(v.requestedScopes).toBe(CEILING);
  });

  it('prunes a justification for a scope the (new) client does not allow', () => {
    const start = {
      ...emptyOffsiteSubmitForm(),
      scopeJustifications: { ModelsRead: 'keep', MediaWrite: 'drop' },
    };
    // A client that only allows ModelsRead → MediaWrite justification is pruned.
    const v = deriveScopesFromClient(start, TokenScope.ModelsRead);
    expect(v.requestedScopes).toBe(TokenScope.ModelsRead);
    expect(v.scopeJustifications).toEqual({ ModelsRead: 'keep' });
  });

  it('an empty-scopes client → 0 mask + no justifications (valid, disclosure-only)', () => {
    const v = deriveScopesFromClient(
      { ...emptyOffsiteSubmitForm(), scopeJustifications: { ModelsRead: 'x' } },
      0
    );
    expect(v.requestedScopes).toBe(0);
    expect(v.scopeJustifications).toEqual({});
  });
});

describe('pruneJustificationsToMask / shapeScopeJustifications', () => {
  it('prune keeps only keys in the mask (values untouched)', () => {
    expect(
      pruneJustificationsToMask({ ModelsRead: '  a  ', MediaWrite: 'b' }, TokenScope.ModelsRead)
    ).toEqual({ ModelsRead: '  a  ' });
  });

  it('shape trims, drops empties, and keeps only mask keys', () => {
    expect(
      shapeScopeJustifications(
        { ModelsRead: '  a  ', UserRead: '   ', MediaWrite: 'x' },
        TokenScope.ModelsRead | TokenScope.UserRead
      )
    ).toEqual({ ModelsRead: 'a' });
  });
});

describe('validateConnectFields', () => {
  it('valid connect fields have no errors', () => {
    const v = full({ requestedScopes: TokenScope.ModelsRead });
    expect(validateConnectFields(v, CEILING)).toEqual({});
  });

  it('flags a missing client', () => {
    const v = full({ connectClientId: null });
    expect(validateConnectFields(v, 0).connectClientId).toBeTruthy();
  });

  it('flags a requested scope outside the ceiling', () => {
    const v = full({ requestedScopes: TokenScope.MediaWrite });
    expect(validateConnectFields(v, CEILING).requestedScopes).toBeTruthy();
  });

  it('flags an over-long justification', () => {
    const v = full({
      requestedScopes: TokenScope.ModelsRead,
      scopeJustifications: { ModelsRead: 'x'.repeat(SCOPE_JUSTIFICATION_MAX_LENGTH + 1) },
    });
    expect(validateConnectFields(v, CEILING).scopeJustifications).toBeTruthy();
  });
});

describe('validateExternalCreateForm (metadata + connect combined)', () => {
  it('valid form has no errors', () => {
    const v = full({ requestedScopes: TokenScope.ModelsRead });
    expect(validateExternalCreateForm(v, CEILING)).toEqual({});
  });

  it('flags a bad slug', () => {
    const v = full({ slug: 'AB', requestedScopes: TokenScope.ModelsRead });
    expect(validateExternalCreateForm(v, CEILING).slug).toBeTruthy();
  });

  it('flags a missing client (via the merged validator)', () => {
    const v = full({ connectClientId: null });
    expect(validateExternalCreateForm(v, 0).connectClientId).toBeTruthy();
  });

  it('an omitted homepage URL is accepted (optional)', () => {
    const v = full({ requestedScopes: TokenScope.ModelsRead, externalUrl: '' });
    expect(validateExternalCreateForm(v, CEILING).externalUrl).toBeUndefined();
  });

  it('a provided non-https homepage URL is rejected', () => {
    const v = full({ requestedScopes: TokenScope.ModelsRead, externalUrl: 'http://insecure.example.com' });
    expect(validateExternalCreateForm(v, CEILING).externalUrl).toBeTruthy();
  });
});

describe('step gates', () => {
  it('client step complete needs a client + a valid subset (URL now gated on its own step)', () => {
    expect(isClientStepComplete(full({ requestedScopes: TokenScope.ModelsRead }), CEILING)).toBe(true);
    expect(isClientStepComplete(full({ connectClientId: null }), 0)).toBe(false);
    expect(isClientStepComplete(full({ requestedScopes: TokenScope.MediaWrite }), CEILING)).toBe(false);
    // The App URL is no longer part of this gate — a present-but-invalid URL doesn't
    // block the App-&-scopes step (it's caught on the first App URL step instead).
    expect(
      isClientStepComplete(
        full({ requestedScopes: TokenScope.ModelsRead, externalUrl: 'http://insecure.example.com' }),
        CEILING
      )
    ).toBe(true);
  });

  it('client step BLOCKS until every SENSITIVE scope is justified', () => {
    // UserRead(1) + ModelsWrite(8) are sensitive; ModelsRead(4) is not.
    const missing = full({ requestedScopes: CEILING });
    expect(isClientStepComplete(missing, CEILING)).toBe(false);
    const justified = full({
      requestedScopes: CEILING,
      scopeJustifications: { UserRead: 'reads the profile', ModelsWrite: 'uploads models' },
    });
    expect(isClientStepComplete(justified, CEILING)).toBe(true);
  });

  it('isCreateUrlStepComplete REQUIRES a valid https App URL (blank blocks; http blocks)', () => {
    expect(isCreateUrlStepComplete(full({ externalUrl: '' }))).toBe(false);
    expect(isCreateUrlStepComplete(full({ externalUrl: 'http://insecure.example.com' }))).toBe(false);
    expect(isCreateUrlStepComplete(full({ externalUrl: 'https://app.example.com' }))).toBe(true);
  });

  it('details step complete needs the whole create mirror valid', () => {
    expect(isCreateDetailsStepComplete(full({ requestedScopes: TokenScope.ModelsRead }), CEILING)).toBe(
      true
    );
    expect(isCreateDetailsStepComplete(full({ name: '' }), CEILING)).toBe(false);
    // A sensitive scope without a justification blocks the details/create gate.
    expect(
      isCreateDetailsStepComplete(full({ requestedScopes: TokenScope.UserRead }), TokenScope.UserRead)
    ).toBe(false);
  });
});

describe('sensitive-only justification model', () => {
  it('partitions a mask into sensitive vs non-sensitive scopes', () => {
    const { sensitive, nonSensitive } = partitionScopesBySensitivity(CEILING);
    expect(sensitive.map((s) => s.key).sort()).toEqual(['ModelsWrite', 'UserRead']);
    expect(nonSensitive.map((s) => s.key)).toEqual(['ModelsRead']);
  });

  it('missingSensitiveJustifications lists only unjustified SENSITIVE scopes', () => {
    // ModelsRead (non-sensitive) is never required even when blank.
    const v = full({
      requestedScopes: CEILING,
      scopeJustifications: { UserRead: 'ok' },
    });
    expect(missingSensitiveJustifications(v)).toEqual(['ModelsWrite']);
    const done = full({
      requestedScopes: CEILING,
      scopeJustifications: { UserRead: 'ok', ModelsWrite: 'ok' },
    });
    expect(missingSensitiveJustifications(done)).toEqual([]);
  });

  it('validateConnectFields REQUIRES sensitive justifications but not non-sensitive ones', () => {
    // Non-sensitive-only scope with no justification → valid.
    expect(
      validateConnectFields(full({ requestedScopes: TokenScope.ModelsRead }), CEILING)
        .scopeJustifications
    ).toBeUndefined();
    // A sensitive scope with no justification → error.
    expect(
      validateConnectFields(full({ requestedScopes: TokenScope.UserRead }), CEILING)
        .scopeJustifications
    ).toBeTruthy();
    // Justified sensitive scope → no error.
    expect(
      validateConnectFields(
        full({ requestedScopes: TokenScope.UserRead, scopeJustifications: { UserRead: 'why' } }),
        CEILING
      ).scopeJustifications
    ).toBeUndefined();
  });

  it('scopeJustificationError flags over-length before missing-required', () => {
    const v = full({
      requestedScopes: TokenScope.UserRead,
      scopeJustifications: { UserRead: 'x'.repeat(SCOPE_JUSTIFICATION_MAX_LENGTH + 1) },
    });
    expect(scopeJustificationError(v)).toMatch(/at most/);
  });

  it('shapeSensitiveJustifications keeps ONLY requested sensitive scopes (prunes non-sensitive)', () => {
    const out = shapeSensitiveJustifications(
      { UserRead: '  keep  ', ModelsRead: 'drop-nonsensitive', ModelsWrite: 'keep2' },
      CEILING
    );
    expect(out).toEqual({ UserRead: 'keep', ModelsWrite: 'keep2' });
  });
});

describe('toSubmitExternalInput', () => {
  it('trims text + omits empty optionals (including a blank App URL)', () => {
    const v = full({
      slug: ' connect-app ',
      name: ' Connect App ',
      // UserRead is SENSITIVE → its justification is kept (non-sensitive would prune).
      requestedScopes: TokenScope.UserRead,
      scopeJustifications: { UserRead: '  reason  ' },
    });
    const input = toSubmitExternalInput(v);
    expect(input.slug).toBe('connect-app');
    expect(input.name).toBe('Connect App');
    expect(input.tagline).toBeUndefined();
    expect(input.externalUrl).toBeUndefined();
    expect(input.connectClientId).toBe('oauth-client-1');
    expect(input.scopeJustifications).toEqual({ UserRead: 'reason' });
  });

  it('passes a provided homepage URL through', () => {
    const v = full({
      requestedScopes: TokenScope.ModelsRead,
      externalUrl: 'https://app.example.com',
    });
    expect(toSubmitExternalInput(v).externalUrl).toBe('https://app.example.com');
  });

  it('drops empty, non-requested, and NON-SENSITIVE justifications', () => {
    const v = full({
      requestedScopes: TokenScope.UserRead,
      scopeJustifications: {
        UserRead: '   ', // sensitive but empty after trim → dropped
        ModelsWrite: 'not requested', // scope not in mask → dropped
      },
    });
    expect(toSubmitExternalInput(v).scopeJustifications).toEqual({});
  });

  it('keeps only requested + non-empty SENSITIVE justifications (non-sensitive pruned)', () => {
    const v = full({
      // ModelsRead(non-sensitive) + UserRead(sensitive) requested.
      requestedScopes: TokenScope.ModelsRead | TokenScope.UserRead,
      scopeJustifications: { ModelsRead: 'a', UserRead: 'keep me', ModelsWrite: 'x' },
    });
    // ModelsRead is non-sensitive → pruned; ModelsWrite not requested → dropped.
    expect(toSubmitExternalInput(v).scopeJustifications).toEqual({ UserRead: 'keep me' });
  });
});
