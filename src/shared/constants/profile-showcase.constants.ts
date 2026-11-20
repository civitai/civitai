import type { ColorDomain } from '~/shared/constants/domain.constants';

/** Bits of a showcase section's `hiddenOn`. 0, the default, shows it on every site. */
export const ShowcaseHiddenOn = {
  /** civitai.com, the green domain. */
  Com: 1 << 0,
  /** civitai.red. It resolves to blue as well as red, so every domain but green is this one. */
  Red: 1 << 1,
} as const;

export const showcaseHiddenOnMask = ShowcaseHiddenOn.Com | ShowcaseHiddenOn.Red;

// Green vs not green, as getUserWithProfile's other split fields: the request color for civitai.red
// is blue (it is blue's primary host), so a check for 'red' would never match there.
const hiddenOnBit = (domain: ColorDomain | undefined) =>
  domain === 'green' ? ShowcaseHiddenOn.Com : ShowcaseHiddenOn.Red;

export const isShowcaseHiddenOn = (hiddenOn: number | undefined, domain: ColorDomain | undefined) =>
  ((hiddenOn ?? 0) & hiddenOnBit(domain)) !== 0;
