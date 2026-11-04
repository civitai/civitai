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
  IconRocket,
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
import { capitalize } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

function formatBoostCopy(
  multiplier: number | string | null | undefined,
  kind: 'rewards' | 'purchases',
  isGreen?: boolean
): string {
  const noun =
    kind === 'rewards'
      ? isGreen
        ? 'Blue Buzz on daily rewards'
        : 'Buzz on daily rewards'
      : 'Buzz on purchases';
  const num = Number(multiplier);
  if (!Number.isFinite(num) || num <= 1) return `No Bonus ${noun}`;
  if (kind === 'purchases') {
    const pct = Math.round((num - 1) * 100);
    return `${pct}% Bonus ${noun}`;
  }
  const rounded = Number(num.toFixed(2));
  return `${rounded}x Bonus ${noun}`;
}

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
  // The colour the plan's monthly Buzz is paid in; delivery falls back to yellow too. Buzz-bought
  // plans grant none and are sold on both sites, so they take the site's colour, as PlanCard does.
  const monthlyBuzzType = metadata.buzzPurchase
    ? features.isGreen
      ? 'green'
      : 'yellow'
    : metadata.buzzType ?? 'yellow';
  const planMeta = {
    name: product?.name ?? 'Supporter Tier',
    buzzType: product.metadata.buzzType,
    tier: product.metadata.tier,
    image:
      metadata?.badge ?? constants.memberships.badges[metadata.tier] ?? constants.supporterBadge,
    benefits: [
      {
        icon: <IconBolt size={benefitIconSize} />,
        iconColor: (metadata?.monthlyBuzz ?? 0) === 0 ? 'gray' : monthlyBuzzType,
        iconVariant: 'light' as ThemeIconVariant,
        content: (
          <Text>
            <Text span>
              {numberWithCommas(metadata?.monthlyBuzz ?? 0)} {capitalize(monthlyBuzzType)} Buzz per
              month
            </Text>
          </Text>
        ),
      },

      features.membershipsV2
        ? (() => {
            const active = (metadata?.purchasesMultiplier ?? 1) !== 1;
            const splitBolt = (
              <div
                style={{
                  position: 'relative',
                  width: benefitIconSize,
                  height: benefitIconSize,
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    clipPath: 'inset(0 0 50% 0)',
                    color: 'var(--mantine-color-yellow-filled)',
                  }}
                >
                  <IconBolt size={benefitIconSize} />
                </div>
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    clipPath: 'inset(50% 0 0 0)',
                    color: 'var(--mantine-color-green-filled)',
                  }}
                >
                  <IconBolt size={benefitIconSize} />
                </div>
              </div>
            );
            return {
              icon: active && features.isGreen ? splitBolt : <IconBolt size={benefitIconSize} />,
              iconColor: !active ? 'gray' : features.isGreen ? 'yellow' : `rgb(var(--buzz-color))`,
              iconVariant: 'light' as ThemeIconVariant,
              iconStyle:
                active && features.isGreen
                  ? {
                      background:
                        'linear-gradient(180deg, var(--mantine-color-yellow-light) 50%, var(--mantine-color-green-light) 50%)',
                    }
                  : undefined,
              content: !active ? (
                <Text>
                  <Text span>No Bonus Buzz on purchases</Text>
                </Text>
              ) : (
                <Text>
                  <Text span>
                    {formatBoostCopy(metadata.purchasesMultiplier!, 'purchases', features.isGreen)}
                  </Text>
                </Text>
              ),
            };
          })()
        : undefined,
      features.membershipsV2
        ? {
            key: 'rewardsMultiplier',
            icon: <IconBolt size={benefitIconSize} />,
            iconColor:
              (metadata?.rewardsMultiplier ?? 1) === 1
                ? 'gray'
                : features.isGreen
                ? 'blue'
                : `rgb(var(--buzz-color))`,
            iconVariant: 'light' as ThemeIconVariant,
            content:
              (metadata?.rewardsMultiplier ?? 1) === 1 ? (
                <Text>
                  <Text span>
                    No Bonus {features.isGreen ? 'Blue Buzz' : 'Buzz'} on daily rewards
                  </Text>
                </Text>
              ) : (
                <Text>
                  <Text span>
                    {formatBoostCopy(metadata.rewardsMultiplier!, 'rewards', features.isGreen)}
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
                <Text td="underline" component="a" href="/train" target="_blank">
                  Private Models
                </Text>
                {!features.isGreen && ' (PG and PG-13 Generation)'}
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
        icon: <IconRocket size={benefitIconSize} />,
        iconColor: !!metadata.tier && metadata.tier !== 'free' ? 'grape' : 'gray',
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
                <Text td="underline" component="a" href="/product/vault" target="_blank">
                  Civitai Vault
                </Text>
                :{' '}
                {(metadata.vaultSizeKb ?? 0) === 0
                  ? 'not included'
                  : `${formatKBytes(metadata.vaultSizeKb ?? 0)} of model storage`}
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
              Unique monthly{' '}
              <Text lh={1} fw={700} span>
                animated
              </Text>{' '}
              badge
            </Text>
          ) : metadata.badgeType === 'static' ? (
            <Text lh={1}>Unique monthly badge</Text>
          ) : (
            <Text lh={1}>No monthly badge</Text>
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
