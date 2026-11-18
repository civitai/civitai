/** Sparteo's head tag for civitai.com, as issued in its platform (property → Get integration tag). */
export const SPARTEO_TAG_SRC: string | null =
  'https://www.flashb.id/universal/f812656a-2eb5-5363-b9fb-90c27d71eb79.js';

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
