import { Alert, Badge, Button, Card, Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconBell,
  IconBolt,
  IconCreditCard,
  IconEye,
  IconKey,
  IconMailCheck,
  IconShieldCheck,
  IconUserCircle,
} from '@tabler/icons-react';
import React from 'react';

import { accountSections, getAccountSectionHref } from '~/components/Account/account-sections';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { NextLink } from '~/components/NextLink/NextLink';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { creatorScoreFromMeta } from '~/shared/utils/creator-score';
import { abbreviateNumber } from '~/utils/number-helpers';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

function StatTile({
  label,
  value,
  icon,
  tone = 'default',
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  tone?: 'default' | 'warning' | 'success';
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md bg-gray-1 p-3 dark:bg-dark-5">
      <Text size="xs" fw={600} tt="uppercase" c="dimmed" className="tracking-wide">
        {label}
      </Text>
      <div className="flex items-center gap-1.5">
        {icon}
        <Text
          size="lg"
          fw={700}
          tt="capitalize"
          c={tone === 'warning' ? 'yellow.6' : tone === 'success' ? 'teal.6' : undefined}
        >
          {value}
        </Text>
      </div>
    </div>
  );
}

const quickLinkIcons: Record<string, React.ReactNode> = {
  notifications: <IconBell size={18} />,
  content: <IconEye size={18} />,
  billing: <IconCreditCard size={18} />,
  security: <IconKey size={18} />,
};

export function AccountOverview() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { data: buzz } = useQueryBuzz();
  const { data: strikeSummary } = trpc.strike.getMyStrikeSummary.useQuery(undefined, {
    enabled: !!currentUser && features.strikes,
  });

  if (!currentUser) return null;

  const emailVerified = !!currentUser.emailVerified;
  const activeStrikes = strikeSummary?.activeStrikes ?? 0;
  const score = creatorScoreFromMeta(currentUser.meta);

  return (
    <>
      {!emailVerified && (
        <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title="Verify your email">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Text size="sm">
              Until you do, you can&apos;t publish models, withdraw Buzz, or recover the account.
            </Text>
          </div>
        </Alert>
      )}

      <Card withBorder padding="lg">
        <div className="flex flex-wrap items-center gap-4">
          <UserAvatar user={currentUser} size="lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Text size="xl" fw={700}>
                {currentUser.username}
              </Text>
              {currentUser.tier ? (
                <Badge color="yellow" tt="capitalize">
                  {currentUser.tier}
                </Badge>
              ) : (
                <Badge color="gray" variant="light">
                  Free
                </Badge>
              )}
            </div>
            <Text size="sm" c="dimmed">
              {currentUser.email}
              {currentUser.createdAt && ` · Member since ${formatDate(currentUser.createdAt)}`}
            </Text>
          </div>
          <Button component={NextLink} href={`/user/${currentUser.username}`} variant="default">
            View profile
          </Button>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Membership"
          value={currentUser.tier ? currentUser.tier : 'Free'}
          icon={<IconUserCircle size={16} className="text-yellow-6" />}
        />
        <StatTile
          label="Buzz balance"
          value={abbreviateNumber(buzz?.total ?? 0)}
          icon={<IconBolt size={16} className="text-yellow-6" />}
        />
        <StatTile
          label={features.strikes ? 'Account standing' : 'Creator score'}
          value={
            features.strikes && activeStrikes > 0
              ? `${activeStrikes} strike${activeStrikes === 1 ? '' : 's'}`
              : abbreviateNumber(score)
          }
          icon={<IconShieldCheck size={16} className="text-teal-6" />}
          tone={activeStrikes > 0 ? 'warning' : 'default'}
        />
        <StatTile
          label="Email"
          value={emailVerified ? 'Verified' : 'Unverified'}
          icon={<IconMailCheck size={16} className={emailVerified ? 'text-teal-6' : 'text-yellow-6'} />}
          tone={emailVerified ? 'success' : 'warning'}
        />
      </div>

      <Text fw={600} mt="xs">
        Jump to
      </Text>
      <div className="grid gap-3 md:grid-cols-2">
        {['notifications', 'content', 'billing', 'security'].map((id) => {
          const section = accountSections.find((item) => item.id === id);
          if (!section) return null;
          return (
            <NextLink
              key={id}
              href={getAccountSectionHref(section)}
              className="no-underline"
            >
              <Card withBorder padding="md" className="h-full">
                <div className="flex items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded bg-blue-1 text-blue-6 dark:bg-blue-8/25">
                    {quickLinkIcons[id]}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <Text size="sm" fw={600}>
                      {section.label}
                    </Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {section.keywords.slice(0, 3).join(', ')}
                    </Text>
                  </div>
                  <IconArrowUpRight size={16} className="text-gray-6 dark:text-dark-2" />
                </div>
              </Card>
            </NextLink>
          );
        })}
      </div>
    </>
  );
}
