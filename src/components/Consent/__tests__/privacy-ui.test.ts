import { describe, expect, it } from 'vitest';
import {
  ADMIRAL_CMP_ID,
  privacyLawApplies,
  shouldShowPrivacyUi,
  type PrivacySignals,
} from '~/components/Consent/privacy-ui';

const ADCONSENT_CMP_ID = 229;
const none: PrivacySignals = {
  cmpId: ADMIRAL_CMP_ID,
  gdprApplies: false,
  uspString: '1---',
  gppSections: [-1],
};

describe('privacyLawApplies', () => {
  it('is false when every signal says no law applies', () => {
    expect(privacyLawApplies(none)).toBe(false);
  });

  it('is true under GDPR', () => {
    expect(privacyLawApplies({ ...none, gdprApplies: true })).toBe(true);
  });

  it('is true when the US Privacy string records a notice (CCPA)', () => {
    expect(privacyLawApplies({ ...none, uspString: '1YNN' })).toBe(true);
  });

  it('is true when GPP reports an applicable section', () => {
    expect(privacyLawApplies({ ...none, gppSections: [8] })).toBe(true);
  });

  it('treats GPP section 0 as none', () => {
    expect(privacyLawApplies({ ...none, gppSections: [0] })).toBe(false);
  });

  it('is false when the CMP gave no signals at all', () => {
    expect(
      privacyLawApplies({ cmpId: null, gdprApplies: null, uspString: null, gppSections: null })
    ).toBe(false);
  });
});

describe('shouldShowPrivacyUi', () => {
  it('shows when Admiral is the CMP and a law applies', () => {
    expect(shouldShowPrivacyUi({ ...none, gdprApplies: true })).toBe(true);
  });

  it('hides when Admiral is the CMP but no law applies', () => {
    expect(shouldShowPrivacyUi(none)).toBe(false);
  });

  it('hides while AdConsent is still the CMP, even where a law applies', () => {
    expect(shouldShowPrivacyUi({ ...none, cmpId: ADCONSENT_CMP_ID, uspString: '1YNN' })).toBe(
      false
    );
  });
});
