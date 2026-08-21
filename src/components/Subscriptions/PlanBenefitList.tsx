import type { DefaultMantineColor, ThemeIconVariant } from '@mantine/core';
import { Divider, List, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconAdCircleOff, IconCircleCheck, IconCircleX } from '@tabler/icons-react';
import { finiteOrNull, monthlyPricingAllowance } from '@civitai/buzz';

export const benefitIconSize = 18;
const themeIconSize = benefitIconSize + 6;

const defaultBenefits = [
  { content: 'Ad free browsing', icon: <IconAdCircleOff size={benefitIconSize} /> },
  {
    content: (
      <Text>
        <Text td="underline" component="a" href="/product/link" target="_blank">
          Civitai Link
        </Text>
        : sync resources to your machine
      </Text>
    ),
  },
  // { content: 'Can equip special cosmetics' },
  { content: 'Exclusive Discord channels' },
  { content: 'Early access to new features' },
  {
    tiers: ['bronze', 'silver', 'gold'], // Not available in supporter / founder.
    creatorProgram: true,
    content: (
      <Text>
        <Text td="underline" component="a" href="/creator-program" target="_blank">
          Creator Program
        </Text>
        : earn from your Buzz
      </Text>
    ),
  },
  {
    // Deliberately NOT creatorProgram-gated: the allowance rides on the tier itself, so
    // Buzz-purchased memberships keep it even though they get no Creator Program.
    tiers: ['bronze', 'silver', 'gold'],
    // Rendered per card from the enforced allowance table, so a card can never advertise a number the
    // server would reject. The un-owned rendering falls back to the qualitative line rather than
    // quoting someone else's allowance.
    content: (tier?: string) => {
      const limit = tier ? finiteOrNull(monthlyPricingAllowance(tier)) : undefined;
      return (
        <Text>
          {limit === undefined ? (
            <>Price more models each month</>
          ) : (
            <>
              Put a price on{' '}
              <Text component="span" fw={600}>
                {limit === null ? 'unlimited models' : `${limit.toLocaleString()} models`}
              </Text>{' '}
              a month — a licensing fee or paid access. Changing a price you have already set is
              always free.
            </>
          )}
        </Text>
      );
    },
  },
  {
    content: 'Unrestricted generation with Blue Buzz',
    tiers: ['bronze', 'silver', 'gold'],
    subType: 'yellow',
  },
  { content: 'Enhanced Model Creator controls', tiers: ['gold'] },
];

export const PlanBenefitList = ({
  benefits,
  useDefaultBenefits = true,
  defaultBenefitsDisabled,
  creatorProgramDisabled,
  tier,
  buzzType,
}: Props) => {
  return (
    <Stack>
      <List
        size="md"
        center
        icon={
          <ThemeIcon color="gray" size={themeIconSize} radius="xl">
            <IconCircleCheck size={benefitIconSize} />
          </ThemeIcon>
        }
      >
        <Stack gap="xs">
          {benefits.map(({ content, icon, iconColor, iconVariant, iconStyle }, index) =>
            content ? (
              <List.Item
                key={index}
                icon={
                  !icon ? undefined : (
                    <ThemeIcon
                      color={iconColor ?? 'teal'}
                      size={themeIconSize}
                      radius="xl"
                      variant={iconVariant}
                      style={iconStyle}
                    >
                      {icon}
                    </ThemeIcon>
                  )
                }
              >
                {content}
              </List.Item>
            ) : null
          )}
        </Stack>
      </List>
      {useDefaultBenefits && (
        <>
          <Divider />
          <List size="md" center>
            <Stack gap="xs">
              {defaultBenefits.map(({ content, tiers, subType, creatorProgram }, index) => {
                const isUnavailable =
                  defaultBenefitsDisabled ||
                  (tiers && (!tier || !tiers.includes(tier))) ||
                  (creatorProgram && creatorProgramDisabled);

                if (subType && buzzType !== subType) return null;

                // A greyed-out card is showing a tier the viewer doesn't have; quoting its number there
                // would read as an entitlement they hold.
                const resolved =
                  typeof content === 'function'
                    ? content(isUnavailable ? undefined : tier)
                    : content;

                return (
                  <List.Item
                    icon={
                      <ThemeIcon
                        color={isUnavailable ? 'gray' : 'green'}
                        variant="light"
                        size={themeIconSize}
                        radius="xl"
                        autoContrast
                      >
                        {isUnavailable ? (
                          <IconCircleX size={benefitIconSize} />
                        ) : (
                          <IconCircleCheck size={benefitIconSize} />
                        )}
                      </ThemeIcon>
                    }
                    key={index}
                  >
                    {resolved}
                  </List.Item>
                );
              })}
            </Stack>
          </List>
        </>
      )}
    </Stack>
  );
};

type Props = {
  benefits: BenefitItem[];
  useDefaultBenefits?: boolean;
  defaultBenefitsDisabled?: boolean;
  /** Crosses out the Creator Program perks regardless of tier — for Buzz-purchased plans. */
  creatorProgramDisabled?: boolean;
  tier?: string;
  buzzType?: string;
};

export type BenefitItem = {
  content: React.ReactNode;
  icon?: React.ReactNode;
  iconColor?: DefaultMantineColor;
  iconVariant?: ThemeIconVariant;
  iconStyle?: React.CSSProperties;
  key?: string;
};
