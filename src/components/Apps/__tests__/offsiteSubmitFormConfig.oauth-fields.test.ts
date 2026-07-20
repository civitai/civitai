import { describe, expect, it } from 'vitest';

import {
  emptyOffsiteSubmitForm,
  isClientStepComplete,
  isCreateDetailsStepComplete,
  toSubmitExternalInput,
  toggleScopeBit,
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

describe('toggleScopeBit', () => {
  it('sets and clears a bit', () => {
    const on = toggleScopeBit(emptyOffsiteSubmitForm(), TokenScope.ModelsRead);
    expect(on.requestedScopes).toBe(TokenScope.ModelsRead);
    const off = toggleScopeBit(on, TokenScope.ModelsRead);
    expect(off.requestedScopes).toBe(0);
  });

  it('prunes a justification when its scope is unchecked', () => {
    let v = toggleScopeBit(emptyOffsiteSubmitForm(), TokenScope.ModelsRead);
    v = { ...v, scopeJustifications: { ModelsRead: 'reason' } };
    const cleared = toggleScopeBit(v, TokenScope.ModelsRead);
    expect(cleared.requestedScopes).toBe(0);
    expect(cleared.scopeJustifications).toEqual({});
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
  it('client step complete needs a client + a valid subset', () => {
    expect(isClientStepComplete(full({ requestedScopes: TokenScope.ModelsRead }), CEILING)).toBe(true);
    expect(isClientStepComplete(full({ connectClientId: null }), 0)).toBe(false);
    expect(isClientStepComplete(full({ requestedScopes: TokenScope.MediaWrite }), CEILING)).toBe(false);
  });

  it('client step rejects a present-but-invalid homepage URL', () => {
    expect(
      isClientStepComplete(
        full({ requestedScopes: TokenScope.ModelsRead, externalUrl: 'http://insecure.example.com' }),
        CEILING
      )
    ).toBe(false);
  });

  it('details step complete needs the whole create mirror valid', () => {
    expect(isCreateDetailsStepComplete(full({ requestedScopes: TokenScope.ModelsRead }), CEILING)).toBe(
      true
    );
    expect(isCreateDetailsStepComplete(full({ name: '' }), CEILING)).toBe(false);
  });
});

describe('toSubmitExternalInput', () => {
  it('trims text + omits empty optionals (including a blank homepage URL)', () => {
    const v = full({
      slug: ' connect-app ',
      name: ' Connect App ',
      requestedScopes: TokenScope.ModelsRead,
      scopeJustifications: { ModelsRead: '  reason  ' },
    });
    const input = toSubmitExternalInput(v);
    expect(input.slug).toBe('connect-app');
    expect(input.name).toBe('Connect App');
    expect(input.tagline).toBeUndefined();
    expect(input.externalUrl).toBeUndefined();
    expect(input.connectClientId).toBe('oauth-client-1');
    expect(input.scopeJustifications).toEqual({ ModelsRead: 'reason' });
  });

  it('passes a provided homepage URL through', () => {
    const v = full({
      requestedScopes: TokenScope.ModelsRead,
      externalUrl: 'https://app.example.com',
    });
    expect(toSubmitExternalInput(v).externalUrl).toBe('https://app.example.com');
  });

  it('drops empty + non-requested justifications', () => {
    const v = full({
      requestedScopes: TokenScope.ModelsRead,
      scopeJustifications: {
        ModelsRead: '   ', // empty after trim → dropped
        ModelsWrite: 'not requested', // scope not in mask → dropped
      },
    });
    expect(toSubmitExternalInput(v).scopeJustifications).toEqual({});
  });

  it('keeps only requested + non-empty justifications', () => {
    const v = full({
      requestedScopes: TokenScope.ModelsRead | TokenScope.UserRead,
      scopeJustifications: { ModelsRead: 'a', UserRead: '', ModelsWrite: 'x' },
    });
    expect(toSubmitExternalInput(v).scopeJustifications).toEqual({ ModelsRead: 'a' });
  });
});
