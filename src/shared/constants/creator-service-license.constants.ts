import { ServiceLicensePreset } from '~/shared/utils/prisma/enums';

// Legal's wording. Never "full rights", "you own it", "work for hire" or "exclusive".
export const SERVICE_LICENSE_PRESET_LABELS: Record<ServiceLicensePreset, string> = {
  [ServiceLicensePreset.Personal]: 'Personal use',
  [ServiceLicensePreset.CommercialCredit]: 'Commercial, credit required',
  [ServiceLicensePreset.CommercialNoCredit]: 'Commercial, no credit',
  [ServiceLicensePreset.Custom]: 'Custom',
};

/** Custom has none: its terms are the seller's own text, shown as written. */
export const SERVICE_LICENSE_PRESET_TERMS: Partial<Record<ServiceLicensePreset, string>> = {
  [ServiceLicensePreset.Personal]:
    'Use the files for your own non-commercial projects. No resale or re-sharing of the files.',
  [ServiceLicensePreset.CommercialCredit]:
    'Use the files and what you make with them commercially. Credit the seller when you publish the files or a model built from them.',
  [ServiceLicensePreset.CommercialNoCredit]:
    'Use the files and what you make with them commercially. No credit needed.',
};

export const SERVICE_LICENSE_COPYRIGHT_LINE =
  'The seller keeps copyright. This is a license to use the work, not a transfer.';
export const SERVICE_LICENSE_RESALE_LABEL = 'May re-share or resell the files';
export const SERVICE_LICENSE_PARTY_LINE =
  "These are the seller's license terms, between you and the seller. Civitai isn't a party to them.";
export const SERVICE_LICENSE_AGREE_LABEL = "I agree to the seller's license terms above.";
export const SERVICE_LICENSE_NONE_LINE =
  'No license terms set: agree terms with the seller in your request.';

export const SERVICE_LICENSE_CUSTOM_TEXT_MAX = 2000;

export type ServiceLicense = {
  licensePreset: ServiceLicensePreset | null;
  licenseCustomText: string | null;
  licenseAllowResale: boolean;
};

/**
 * What an offering stores for a license: custom text only with Custom, and no resale with Personal
 * use, whose own terms rule it out. A Custom preset left without text comes back with none.
 */
export function normalizeServiceLicense(input: {
  licensePreset: ServiceLicensePreset | null;
  licenseCustomText?: string | null;
  licenseAllowResale?: boolean;
}): ServiceLicense {
  const preset = input.licensePreset;
  const customText = preset === ServiceLicensePreset.Custom ? input.licenseCustomText?.trim() : '';
  return {
    licensePreset: preset,
    licenseCustomText: customText || null,
    licenseAllowResale:
      !!preset && preset !== ServiceLicensePreset.Personal && !!input.licenseAllowResale,
  };
}

/** Whether the resale toggle means anything for this preset. */
export const serviceLicenseHasResaleToggle = (preset: ServiceLicensePreset | null) =>
  !!preset && preset !== ServiceLicensePreset.Personal;
