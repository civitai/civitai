import { Anchor, Badge, Divider, Group, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { formatDate } from '~/utils/date-helpers';
import { capitalize } from '~/utils/string-helpers';
import styles from './BuzzMembershipCallout.module.scss';

type Props = {
  /** Set when describing a membership the user already holds; omit on the purchase page. */
  tier?: string;
  expiresAt?: Date;
};

/**
 * The single explanation of what a Buzz-purchased membership is and isn't. Shared so
 * `/user/membership` and `/pricing/buzz` can't drift into describing it differently — the
 * exclusions are the part users get wrong, so they carry equal weight to the inclusions
 * rather than trailing off the end of a sentence.
 */
export function BuzzMembershipCallout({ tier, expiresAt }: Props) {
  const heading = tier ? `${capitalize(tier)} Perks` : 'Perks membership';

  return (
    <Paper withBorder radius="lg" p="lg" className={styles.callout}>
      <Stack gap="md">
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <ThemeIcon size={42} radius="md" variant="light" color="blue">
            <IconBolt size={26} strokeWidth={2.5} />
          </ThemeIcon>
          <Stack gap={2}>
            <Group gap="xs">
              <Text fw={700} size="lg" lh={1.2}>
                {heading}
              </Text>
              <Badge color="blue" variant="filled" radius="sm">
                Buzz purchase
              </Badge>
            </Group>
            <Text size="sm" c="dimmed" lh={1.3}>
              A perks-only membership bought with Buzz — not a paid subscription.
            </Text>
          </Stack>
        </Group>

        <Divider />

        <Group align="flex-start" gap="xl" wrap="wrap">
          <Stack gap={4} style={{ flex: 1, minWidth: 220 }}>
            <Text size="xs" fw={700} tt="uppercase" c="dimmed">
              What you get
            </Text>
            <Text size="sm" lh={1.4}>
              {tier ? `Every ${capitalize(tier)} perk` : 'Every perk of the tier you pick'} —
              generation limits, priority, Vault, private models and support —{' '}
              {expiresAt ? (
                <>
                  through{' '}
                  <Text component="span" fw={600}>
                    {formatDate(expiresAt)}
                  </Text>
                  .
                </>
              ) : (
                <>for one month.</>
              )}
            </Text>
          </Stack>
          <Stack gap={4} style={{ flex: 1, minWidth: 220 }}>
            <Text size="xs" fw={700} tt="uppercase" c="dimmed">
              What it does not include
            </Text>
            <Text size="sm" lh={1.4}>
              Monthly Buzz, bonus Buzz on purchases or rewards, the monthly badge, and the Creator
              Program.
            </Text>
          </Stack>
        </Group>

        <Text size="sm" c="dimmed" lh={1.4}>
          It <strong>does not renew automatically</strong>.{' '}
          {expiresAt ? (
            <>
              When it expires you can{' '}
              <Anchor component={Link} href="/pricing/buzz">
                buy another month with Buzz
              </Anchor>{' '}
              or{' '}
              <Anchor component={Link} href="/pricing">
                start a paid membership
              </Anchor>{' '}
              for the full set of benefits.
            </>
          ) : (
            <>
              You buy one month at a time, and can only hold one membership — Buzz or paid — at
              once.
            </>
          )}
        </Text>
      </Stack>
    </Paper>
  );
}
