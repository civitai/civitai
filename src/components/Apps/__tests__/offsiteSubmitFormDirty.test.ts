import { describe, expect, it } from 'vitest';
import {
  emptyOffsiteSubmitForm,
  isOffsiteSubmitFormDirty,
} from '~/components/Apps/offsiteSubmitFormConfig';

/**
 * The predicate behind the create wizard's Cancel confirmation.
 *
 * WHY IT MATTERS BOTH WAYS. `Cancel` navigates away and discards every field with no
 * undo, so a dirty form must confirm. But a confirmation that fires on an UNTOUCHED
 * form is a nag, and a nag is dismissed reflexively — which would make the dialog
 * worthless on the one occasion it protects real work. Both directions are asserted
 * here; neither alone is the requirement.
 */
describe('isOffsiteSubmitFormDirty', () => {
  it('a freshly-initialised form is PRISTINE', () => {
    expect(isOffsiteSubmitFormDirty(emptyOffsiteSubmitForm())).toBe(false);
  });

  /**
   * 🔴 THE ONE THAT KILLS THE OBVIOUS WRONG IMPLEMENTATION.
   *
   * `contentRating` starts at `'g'` — it is the only field whose blank value is
   * truthy. An `Object.values(values).some(Boolean)` shortcut (or any "is anything
   * set?" check) therefore reports a brand-new form as dirty and nags every single
   * author on their first click. This case is the difference between the predicate
   * and that shortcut, and it is why the comparison is against the DEFAULT rather
   * than against emptiness.
   */
  it('the non-empty DEFAULT contentRating does not make a pristine form dirty', () => {
    const values = emptyOffsiteSubmitForm();
    expect(values.contentRating).toBe('g'); // the default is genuinely non-empty
    expect(isOffsiteSubmitFormDirty(values)).toBe(false);
  });

  it.each([
    ['externalUrl', 'https://example.com/app'],
    ['name', 'My App'],
    ['slug', 'my-app'],
    ['tagline', 'Does a thing'],
    ['description', 'A longer description.'],
    ['changelog', 'A note for the reviewer.'],
  ] as const)('typing into `%s` makes the form dirty', (field, value) => {
    expect(isOffsiteSubmitFormDirty({ ...emptyOffsiteSubmitForm(), [field]: value })).toBe(true);
  });

  it('CHANGING the content rating away from the default makes it dirty', () => {
    expect(isOffsiteSubmitFormDirty({ ...emptyOffsiteSubmitForm(), contentRating: 'r' })).toBe(
      true
    );
  });

  it('picking a category makes it dirty', () => {
    expect(
      isOffsiteSubmitFormDirty({ ...emptyOffsiteSubmitForm(), category: 'productivity' })
    ).toBe(true);
  });

  it('picking an OAuth client makes it dirty', () => {
    expect(
      isOffsiteSubmitFormDirty({ ...emptyOffsiteSubmitForm(), connectClientId: 'oauth-client-1' })
    ).toBe(true);
  });

  it('derived requested scopes make it dirty', () => {
    expect(isOffsiteSubmitFormDirty({ ...emptyOffsiteSubmitForm(), requestedScopes: 4 })).toBe(
      true
    );
  });

  it('a written scope justification makes it dirty', () => {
    expect(
      isOffsiteSubmitFormDirty({
        ...emptyOffsiteSubmitForm(),
        scopeJustifications: { UserRead: 'To greet the user by name.' },
      })
    ).toBe(true);
  });

  /**
   * Picking a client RE-KEYS `scopeJustifications` to empty strings before the author
   * writes anything. Those empty entries are not work, so they must not, on their
   * own, be what makes the form dirty — `connectClientId` already reports that choice.
   */
  it('EMPTY re-keyed justifications are not, by themselves, dirt', () => {
    expect(
      isOffsiteSubmitFormDirty({
        ...emptyOffsiteSubmitForm(),
        scopeJustifications: { UserRead: '', ModelsRead: '' },
      })
    ).toBe(false);
  });

  it('whitespace-only input is not dirt (a stray space is not work)', () => {
    expect(isOffsiteSubmitFormDirty({ ...emptyOffsiteSubmitForm(), name: '   ' })).toBe(false);
    expect(
      isOffsiteSubmitFormDirty({
        ...emptyOffsiteSubmitForm(),
        scopeJustifications: { UserRead: '  \n ' },
      })
    ).toBe(false);
  });
});
