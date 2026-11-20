import type { ColorDomain } from '~/shared/constants/domain.constants';

/** Bits of a showcase section's `hiddenOn`. 0, the default, shows it on every site. */
export const ShowcaseHiddenOn = {
  /** civitai.com: the green and blue domains. */
  Com: 1 << 0,
  /** civitai.red. */
  Red: 1 << 1,
} as const;

export const showcaseHiddenOnMask = ShowcaseHiddenOn.Com | ShowcaseHiddenOn.Red;

const hiddenOnBit = (domain: ColorDomain | undefined) =>
  domain === 'red' ? ShowcaseHiddenOn.Red : ShowcaseHiddenOn.Com;

export const isShowcaseHiddenOn = (hiddenOn: number | undefined, domain: ColorDomain | undefined) =>
  ((hiddenOn ?? 0) & hiddenOnBit(domain)) !== 0;
