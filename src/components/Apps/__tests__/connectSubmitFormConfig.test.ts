import { describe, expect, it } from 'vitest';

import {
  emptyConnectSubmitForm,
  isConnectClientStepComplete,
  isConnectDetailsStepComplete,
  toSubmitConnectInput,
  toggleScopeBit,
  validateConnectSubmitForm,
  type ConnectSubmitFormValues,
} from '~/components/Apps/connectSubmitFormConfig';
import { SCOPE_JUSTIFICATION_MAX_LENGTH, TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * W13 OAuth-connect submit form CONFIG (client-side mirror) tests (PR2). Pure
 * view-model — no DOM. Covers the scope toggle + prune, the subset gating, and the
 * payload shaping (omit empty / non-requested justifications).
 */

const CEILING = TokenScope.UserRead | TokenScope.ModelsRead | TokenScope.ModelsWrite; // 13

function full(overrides: Partial<ConnectSubmitFormValues> = {}): ConnectSubmitFormValues {
  return {
    ...emptyConnectSubmitForm(),
    connectClientId: 'oauth-client-1',
    slug: 'connect-app',
    name: 'Connect App',
    ...overrides,
  };
}

describe('toggleScopeBit', () => {
  it('sets and clears a bit', () => {
    const on = toggleScopeBit(emptyConnectSubmitForm(), TokenScope.ModelsRead);
    expect(on.requestedScopes).toBe(TokenScope.ModelsRead);
    const off = toggleScopeBit(on, TokenScope.ModelsRead);
    expect(off.requestedScopes).toBe(0);
  });

  it('prunes a justification when its scope is unchecked', () => {
    let v = toggleScopeBit(emptyConnectSubmitForm(), TokenScope.ModelsRead);
    v = { ...v, scopeJustifications: { ModelsRead: 'reason' } };
    const cleared = toggleScopeBit(v, TokenScope.ModelsRead);
    expect(cleared.requestedScopes).toBe(0);
    expect(cleared.scopeJustifications).toEqual({});
  });
});

describe('validateConnectSubmitForm', () => {
  it('valid form has no errors', () => {
    const v = full({ requestedScopes: TokenScope.ModelsRead });
    expect(validateConnectSubmitForm(v, CEILING)).toEqual({});
  });

  it('flags a missing client', () => {
    const v = full({ connectClientId: null });
    expect(validateConnectSubmitForm(v, 0).connectClientId).toBeTruthy();
  });

  it('flags a requested scope outside the ceiling', () => {
    const v = full({ requestedScopes: TokenScope.MediaWrite });
    expect(validateConnectSubmitForm(v, CEILING).requestedScopes).toBeTruthy();
  });

  it('flags an over-long justification', () => {
    const v = full({
      requestedScopes: TokenScope.ModelsRead,
      scopeJustifications: { ModelsRead: 'x'.repeat(SCOPE_JUSTIFICATION_MAX_LENGTH + 1) },
    });
    expect(validateConnectSubmitForm(v, CEILING).scopeJustifications).toBeTruthy();
  });

  it('flags a bad slug', () => {
    const v = full({ slug: 'AB', requestedScopes: TokenScope.ModelsRead });
    expect(validateConnectSubmitForm(v, CEILING).slug).toBeTruthy();
  });
});

describe('step gates', () => {
  it('client step complete needs a client + a valid subset', () => {
    expect(isConnectClientStepComplete(full({ requestedScopes: TokenScope.ModelsRead }), CEILING)).toBe(
      true
    );
    expect(isConnectClientStepComplete(full({ connectClientId: null }), 0)).toBe(false);
    expect(
      isConnectClientStepComplete(full({ requestedScopes: TokenScope.MediaWrite }), CEILING)
    ).toBe(false);
  });

  it('details step complete needs the whole mirror valid', () => {
    expect(
      isConnectDetailsStepComplete(full({ requestedScopes: TokenScope.ModelsRead }), CEILING)
    ).toBe(true);
    expect(isConnectDetailsStepComplete(full({ name: '' }), CEILING)).toBe(false);
  });
});

describe('toSubmitConnectInput', () => {
  it('trims text + omits empty optionals', () => {
    const v = full({
      slug: ' connect-app ',
      name: ' Connect App ',
      requestedScopes: TokenScope.ModelsRead,
      scopeJustifications: { ModelsRead: '  reason  ' },
    });
    const input = toSubmitConnectInput(v);
    expect(input.slug).toBe('connect-app');
    expect(input.name).toBe('Connect App');
    expect(input.tagline).toBeUndefined();
    expect(input.scopeJustifications).toEqual({ ModelsRead: 'reason' });
  });

  it('drops empty + non-requested justifications', () => {
    const v = full({
      requestedScopes: TokenScope.ModelsRead,
      scopeJustifications: {
        ModelsRead: '   ', // empty after trim → dropped
        ModelsWrite: 'not requested', // scope not in mask → dropped
      },
    });
    expect(toSubmitConnectInput(v).scopeJustifications).toEqual({});
  });

  it('keeps only requested + non-empty justifications', () => {
    const v = full({
      requestedScopes: TokenScope.ModelsRead | TokenScope.UserRead,
      scopeJustifications: { ModelsRead: 'a', UserRead: '', ModelsWrite: 'x' },
    });
    expect(toSubmitConnectInput(v).scopeJustifications).toEqual({ ModelsRead: 'a' });
  });
});
