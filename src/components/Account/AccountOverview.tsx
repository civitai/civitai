import { Alert, Button, Card, Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconBell,
  IconCreditCard,
  IconEye,
  IconKey,
  IconMailCheck,
  IconPencilMinus,
  IconShieldCheck,
  IconShieldExclamation,
  IconUserCircle,
} from '@tabler/icons-react';
import React from 'react';

import { accountSections, getAccountSectionHref } from '~/components/Account/account-sections';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink } from '~/components/NextLink/NextLink';
import { openUserProfileEditModal } from '~/components/Dialog/triggers/user-profile-edit';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { getPlanDetails } from '~/components/Subscriptions/getPlanDetails';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { Username } from '~/components/User/Username';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { accountStandingFromPoints } from '~/server/schema/strike.schema';
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

/** Tailwind only emits classes it can see literally, so the standing colours cannot be templated. */
const standingTextClass: Record<string, string> = {
  green: 'text-green-6',
  yellow: 'text-yellow-6',
  red: 'text-red-6',
};

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
  // Equipped cosmetics aren't on the session user, so the nameplate and badge need the profile.
  const { data: profile } = trpc.userProfile.get.useQuery(
    { username: currentUser?.username ?? '' },
    { enabled: !!currentUser?.username }
  );
  const { subscription } = useActiveSubscription({ includeBuzzPurchase: true });

  if (!currentUser) return null;

  const emailVerified = !!currentUser.emailVerified;
  const standing = accountStandingFromPoints(strikeSummary?.totalActivePoints ?? 0);
  const StandingIcon = standing.good ? IconShieldCheck : IconShieldExclamation;
  const tierBadge = subscription ? getPlanDetails(subscription.product, features).image : undefined;
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
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <UserAvatar user={currentUser} size="lg" />
            <div className="flex min-w-0 flex-col gap-1">
              <Username
                username={currentUser.username}
                cosmetics={profile?.cosmetics}
                size="xl"
                badgeSize={26}
              />
              <Text size="sm" c="dimmed">
                {currentUser.email}
                {currentUser.createdAt && ` · Member since ${formatDate(currentUser.createdAt)}`}
              </Text>
            </div>
          </div>
          <Button
            variant="default"
            leftSection={<IconPencilMinus size={16} />}
            onClick={() => openUserProfileEditModal()}
            className="shrink-0"
          >
            Customize profile
          </Button>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Membership"
          href="/user/membership"
          icon={
            tierBadge ? (
              <EdgeMedia src={tierBadge} width={40} className="size-5" />
            ) : (
              <IconUserCircle size={16} className="text-yellow-6" />
            )
          }
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
          label="Standing"
          href={getAccountSectionHref(
            accountSections.find((section) => section.id === 'profile') ?? accountSections[0]
          )}
          icon={<StandingIcon size={16} className={standingTextClass[standing.color]} />}
        >
          <Text size="lg" fw={700} c={`${standing.color}.6`}>
            {standing.short}
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
              className={emailVerified ? 'text-green-6' : 'text-yellow-6'}
            />
          }
        >
          <Text size="lg" fw={700} c={emailVerified ? 'green.6' : 'yellow.6'}>
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
