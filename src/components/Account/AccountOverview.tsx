import { Alert, Button, Card, Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconBell,
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
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { NextLink } from '~/components/NextLink/NextLink';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { creatorScoreFromMeta } from '~/shared/utils/creator-score';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

function StatTile({
  label,
  href,
  icon,
  children,
}: {
  label: string;
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <NextLink
      href={href}
      className="flex flex-col gap-1 rounded-md bg-gray-1 p-3 no-underline transition-colors hover:bg-gray-2 dark:bg-dark-5 dark:hover:bg-dark-4"
    >
      <div className="flex items-center justify-between gap-2">
        <Text size="xs" fw={600} tt="uppercase" c="dimmed" className="tracking-wide">
          {label}
        </Text>
        <IconArrowUpRight size={13} className="text-gray-6 dark:text-dark-2" />
      </div>
      <div className="flex items-center gap-1.5">
        {icon}
        {children}
      </div>
    </NextLink>
  );
}

const quickLinks: { id: string; icon: React.ReactNode }[] = [
  { id: 'notifications', icon: <IconBell size={18} /> },
  { id: 'content', icon: <IconEye size={18} /> },
  { id: 'billing', icon: <IconCreditCard size={18} /> },
  { id: 'security', icon: <IconKey size={18} /> },
];

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
  const funded = (buzz?.accounts ?? []).filter((account) => account.balance > 0);

  return (
    <>
      {!emailVerified && (
        <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title="Verify your email">
          <Text size="sm">
            Until you do, you can&apos;t publish models, withdraw Buzz, or recover the account.
          </Text>
        </Alert>
      )}

      <Card withBorder padding="lg">
        <div className="flex flex-wrap items-center gap-4">
          <UserAvatar user={currentUser} size="lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Text size="xl" fw={700}>
              {currentUser.username}
            </Text>
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
          href="/pricing"
          icon={<IconUserCircle size={16} className="text-yellow-6" />}
        >
          <Text size="lg" fw={700} tt="capitalize">
            {currentUser.tier ?? 'Free'}
          </Text>
        </StatTile>

        <StatTile
          label="Buzz balance"
          href="/user/buzz-dashboard"
          icon={<CurrencyIcon currency="BUZZ" size={16} />}
        >
          <div className="flex min-w-0 flex-col">
            <Text size="lg" fw={700}>
              {(buzz?.total ?? 0).toLocaleString()}
            </Text>
            {funded.length > 1 && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {funded.map((account) => (
                  <div key={account.type} className="flex items-center gap-0.5">
                    <CurrencyIcon currency="BUZZ" type={account.type} size={11} />
                    <Text size="xs" c="dimmed">
                      {account.balance.toLocaleString()}
                    </Text>
                  </div>
                ))}
              </div>
            )}
          </div>
        </StatTile>

        <StatTile
          label={features.strikes ? 'Account standing' : 'Creator score'}
          href={getAccountSectionHref(
            accountSections.find((section) => section.id === 'profile') ?? accountSections[0]
          )}
          icon={
            <IconShieldCheck
              size={16}
              className={activeStrikes > 0 ? 'text-yellow-6' : 'text-teal-6'}
            />
          }
        >
          <Text size="lg" fw={700} c={activeStrikes > 0 ? 'yellow.6' : undefined}>
            {features.strikes && activeStrikes > 0
              ? `${activeStrikes} strike${activeStrikes === 1 ? '' : 's'}`
              : score.toLocaleString()}
          </Text>
        </StatTile>

        <StatTile
          label="Email"
          href={getAccountSectionHref(
            accountSections.find((section) => section.id === 'profile') ?? accountSections[0]
          )}
          icon={
            <IconMailCheck
              size={16}
              className={emailVerified ? 'text-teal-6' : 'text-yellow-6'}
            />
          }
        >
          <Text size="lg" fw={700} c={emailVerified ? 'teal.6' : 'yellow.6'}>
            {emailVerified ? 'Verified' : 'Unverified'}
          </Text>
        </StatTile>
      </div>

      <Text fw={600} mt="xs">
        Jump to
      </Text>
      <div className="grid gap-3 md:grid-cols-2">
        {quickLinks.map(({ id, icon }) => {
          const section = accountSections.find((item) => item.id === id);
          if (!section) return null;
          return (
            <NextLink key={id} href={getAccountSectionHref(section)} className="no-underline">
              <Card withBorder padding="md" className="h-full">
                <div className="flex items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded bg-blue-1 text-blue-6 dark:bg-blue-8/25">
                    {icon}
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
