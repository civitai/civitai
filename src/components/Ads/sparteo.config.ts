/** Sparteo's head tag for civitai.com, as issued in its platform (property → Get integration tag). */
export const SPARTEO_TAG_SRC: string | null =
  'https://www.flashb.id/universal/f812656a-2eb5-5363-b9fb-90c27d71eb79.js';

export type SparteoTcfRequirements = {
  vendorId: number;
  consentPurposes: readonly number[];
  legIntPurposes: readonly number[];
};

/** What Sparteo's IAB Global Vendor List entry requires where GDPR applies; re-check it when the entry changes. */
export const SPARTEO_TCF: SparteoTcfRequirements = {
  vendorId: 1028,
  consentPurposes: [1, 3, 4],
  legIntPurposes: [2],
};
