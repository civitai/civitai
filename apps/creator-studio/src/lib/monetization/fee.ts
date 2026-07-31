// Licensing-fee helpers — the single source of truth lives in @civitai/buzz (browser-safe, used by the main
// app too). Re-exported here so spoke imports stay pointed at $lib/monetization/fee. formatFeeRatio renders
// the media-agnostic "N ⚡ / M generations" label (fees apply to images, video, etc.).
export {
  MAX_LICENSING_FEE,
  FEE_IMAGE_OPTIONS,
  DEFAULT_FEE_IMAGES,
  SUGGESTED_FEE_PER_IMAGE,
  DEFAULT_SUGGESTED_FEE_PER_IMAGE,
  feeToRatio,
  ratioToFee,
  suggestedFeePerImage,
  formatFeeRatio,
  maxLicensingFee,
  maxFeeBuzzForRatio,
  feeImageOptionsForCap,
} from '@civitai/buzz';
export type { FeeRatio } from '@civitai/buzz';
