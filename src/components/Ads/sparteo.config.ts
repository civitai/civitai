/**
 * Sparteo's head tag. `null` renders nothing even with the `sparteoAds` flag on; set it from the
 * tag Sparteo issues for civitai.com, never a guessed URL.
 */
export const SPARTEO_TAG_SRC: string | null = null;

export type SparteoTcfRequirements = {
  vendorId: number;
  consentPurposes: readonly number[];
  legIntPurposes: readonly number[];
};

/**
 * What a visitor must grant where GDPR applies, from Sparteo's entry in the IAB Global Vendor List
 * (vendor 1028, list v185): vendor consent; consent to purposes 1 (store/access on a device),
 * 3 and 4 (personalised ad profile and selection); purpose 2 (basic ads) by consent or by
 * legitimate interest the visitor has not objected to. Re-check if Sparteo's GVL entry changes.
 */
export const SPARTEO_TCF: SparteoTcfRequirements = {
  vendorId: 1028,
  consentPurposes: [1, 3, 4],
  legIntPurposes: [2],
};
