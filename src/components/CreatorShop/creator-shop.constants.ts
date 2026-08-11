import { numberWithCommas } from '~/utils/number-helpers';

export const CREATOR_SHOP_BORDER = '1px solid var(--mantine-color-default-border)';

/**
 * Review-queue label for the fee an item paid. Fees are operator-tunable, so an
 * item submitted before the amount was recorded gets no number at all — today's
 * configured fee is not what it paid.
 */
export const submissionFeeLabel = (submissionFee: number | undefined) =>
  submissionFee === undefined ? 'Paid' : `${numberWithCommas(submissionFee)} · Paid`;

// Cosmetic quality standards doc shown to creators during submission
// (src/static-content/cosmetic-standards.md, served via content.get — also
// browsable at /content/cosmetic-standards).
export const COSMETIC_STANDARDS_SLUG = 'cosmetic-standards';

// Standalone tool for designing cosmetics that meet the standards below.
export const COSMETIC_STUDIO_URL = 'https://cosmetic-studio.civitai.com/';
