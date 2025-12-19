import type { ThemeIconVariant } from '@mantine/core';
import { Text } from '@mantine/core';
import {
  IconBolt,
  IconCategory,
  IconChristmasTree,
  IconCloud,
  IconHeartHandshake,
  IconHexagon,
  IconHexagon3d,
  IconHexagonPlus,
  IconList,
  IconPhotoAi,
} from '@tabler/icons-react';
import type { BenefitItem } from '~/components/Subscriptions/PlanBenefitList';
import { benefitIconSize } from '~/components/Subscriptions/PlanBenefitList';
import { constants, HOLIDAY_PROMO_VALUE } from '~/server/common/constants';
import type {
  ProductTier,
  SubscriptionProductMetadata,
} from '~/server/schema/subscriptions.schema';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { SubscriptionPlan } from '~/server/services/subscriptions.service';
import { formatKBytes, numberWithCommas } from '~/utils/number-helpers';
import { isDefined } from '~/utils/type-guards';

export const getPlanDetails: (
  product: Pick<SubscriptionPlan, 'metadata' | 'name'>,
  features: FeatureAccess,
  isAnnual?: boolean
) => PlanMeta = (
  product: Pick<SubscriptionPlan, 'metadata' | 'name'>,
  features: FeatureAccess,
  isAnnual
) => {
  const metadata = (product.metadata ?? {}) as SubscriptionProductMetadata;
  const planMeta = {
    name: product?.name ?? 'Supporter Tier',
    buzzType: product.metadata.buzzType,
    tier: product.metadata.tier,
    image:
      metadata?.badge ?? constants.memberships.badges[metadata.tier] ?? constants.supporterBadge,
    benefits: [
      {
        icon: <IconBolt size={benefitIconSize} />,
        iconColor: (metadata?.monthlyBuzz ?? 0) === 0 ? 'gray' : 'rgb(var(--buzz-color))',
        iconVariant: 'light' as ThemeIconVariant,
        content: (
          <Text>
            <Text span>{numberWithCommas(metadata?.monthlyBuzz ?? 0)} Buzz per month</Text>
          </Text>
        ),
      },

      features.membershipsV2 && features.isGreen
        ? {
            icon: <IconBolt size={benefitIconSize} />,
            iconColor:
              (metadata?.purchasesMultiplier ?? 1) === 1 ? 'gray' : `rgb(var(--buzz-color))`,
            iconVariant: 'light' as ThemeIconVariant,
            content:
              (metadata?.purchasesMultiplier ?? 1) === 1 ? (
                <Text>
                  <Text span>No bonus Buzz on purchases</Text>
                </Text>
              ) : (
                <Text>
                  <Text span>
                    {(((metadata?.purchasesMultiplier ?? 1) - 1) * 100).toFixed(0)}% Bonus Buzz on
                    purchases
                  </Text>
                </Text>
              ),
          }
        : undefined,
      features.membershipsV2
        ? {
            icon: <IconBolt size={benefitIconSize} />,
            iconColor: (metadata?.rewardsMultiplier ?? 1) === 1 ? 'gray' : `rgb(var(--buzz-color))`,
            iconVariant: 'light' as ThemeIconVariant,
            content:
              (metadata?.rewardsMultiplier ?? 1) === 1 ? (
                <Text>
                  <Text span>No extra Buzz on rewards</Text>
                </Text>
              ) : (
                <Text>
                  <Text span>
                    Rewards give {(((metadata?.rewardsMultiplier ?? 1) - 1) * 100).toFixed(0)}% more
                    Buzz!
                  </Text>
                </Text>
              ),
          }
        : undefined,
      features.privateModels
        ? {
            icon: <IconCategory size={benefitIconSize} />,
            iconColor: 'grape',

            iconVariant: 'light' as ThemeIconVariant,
            content: (
              <Text>
                {numberWithCommas(
                  metadata?.maxPrivateModels ??
                    constants.memberships.membershipDetailsAddons[metadata.tier]
                      ?.maxPrivateModels ??
                    0
                )}{' '}
                Private Models (PG and PG-13 Generation)
              </Text>
            ),
          }
        : null,
      {
        icon: <IconPhotoAi size={benefitIconSize} />,
        iconColor: 'grape',
        iconVariant: 'light' as ThemeIconVariant,
        content: <Text>{metadata.quantityLimit ?? 4} Images per job</Text>,
      },
      {
        icon: <IconList size={benefitIconSize} />,
        iconColor: 'grape',
        iconVariant: 'light' as ThemeIconVariant,
        content: <Text>{metadata.queueLimit ?? 4} Queued jobs</Text>,
      },
      {
        icon: <IconBolt size={benefitIconSize} />,
        iconColor: !!metadata.tier && metadata.tier !== 'free' ? 'blue' : 'gray',
        iconVariant: 'light' as ThemeIconVariant,
        content: (
          <Text>
            {!!metadata.tier && metadata.tier !== 'free' ? (
              <>Free High priority generation</>
            ) : (
              <>Standard priority generation</>
            )}
          </Text>
        ),
      },
      features.vault
        ? {
            content: (
              <Text>
                {(metadata.vaultSizeKb ?? 0) === 0
                  ? 'No '
                  : formatKBytes(metadata.vaultSizeKb ?? 0)}{' '}
                <Text td="underline" component="a" href="/product/vault" target="_blank">
                  Civitai Vault storage
                </Text>
              </Text>
            ),
            icon: <IconCloud size={benefitIconSize} />,
            iconColor: metadata.vaultSizeKb ? 'grape' : 'gray',
            iconVariant: 'light' as ThemeIconVariant,
          }
        : undefined,
      {
        icon: <IconHeartHandshake size={benefitIconSize} />,
        iconColor: !!metadata.tier && metadata.tier !== 'free' ? 'grape' : 'gray',

        iconVariant: 'light' as ThemeIconVariant,
        content: (
          <Text>
            {metadata?.supportLevel ??
              constants.memberships.membershipDetailsAddons[metadata.tier]?.supportLevel ??
              'Basic'}{' '}
            Support
          </Text>
        ),
      },
      {
        content:
          metadata.badgeType === 'animated' ? (
            <Text lh={1}>
              Unique{' '}
              <Text lh={1} fw={700} span>
                Animated
              </Text>{' '}
              Supporter Badge each month
            </Text>
          ) : metadata.badgeType === 'static' ? (
            <Text lh={1}>Unique Supporter Badge each month</Text>
          ) : (
            <Text lh={1}>No Unique Supporter Badge each month</Text>
          ),
        icon:
          metadata.badgeType === 'animated' ? (
            <IconHexagonPlus size={benefitIconSize} />
          ) : (
            <IconHexagon size={benefitIconSize} />
          ),
        iconColor: !metadata.badgeType || metadata.badgeType === 'none' ? 'gray' : 'grape',
        iconVariant: 'light' as ThemeIconVariant,
      },
      {
        content:
          !!metadata.badgeType && !!isAnnual ? (
            <Text lh={1}>
              <Text td="underline" component="a" href="/articles/14950" target="_blank">
                Exclusive cosmetics
              </Text>
            </Text>
          ) : !!isAnnual ? (
            <Text lh={1}>
              No{' '}
              <Text td="underline" component="a" href="/articles/14950" target="_blank">
                exclusive cosmetics
              </Text>
            </Text>
          ) : null,
        icon: <IconHexagon3d size={benefitIconSize} />,
        iconColor:
          !metadata.badgeType || metadata.badgeType === 'none' || !isAnnual ? 'gray' : 'grape',
        iconVariant: 'light' as ThemeIconVariant,
      },
    ].filter(isDefined),
  };

  return planMeta;
};

export type PlanMeta = {
  name: string;
  image: string;
  buzzType: string;
  tier: ProductTier;
  benefits: BenefitItem[];
};
