import type { ReactNode } from 'react';
import {
  Alert,
  Anchor,
  Center,
  Container,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconExclamationMark, IconInfoCircle, IconInfoTriangleFilled } from '@tabler/icons-react';
import clsx from 'clsx';
import Image from 'next/image';
import { Meta } from '~/components/Meta/Meta';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { BuzzTopUpCard } from '~/components/Buzz/BuzzTopUpCard';
import { PromoBanner } from '~/components/Buzz/PromoBanner';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isHolidaysTime } from '~/utils/date-helpers';
import type { JoinRedirectReason } from '~/utils/join-helpers';
import { joinRedirectReasons } from '~/utils/join-helpers';
import classes from './MembershipPageWrapper.module.scss';

interface MembershipPageWrapperProps {
  title: string;
  introText?: string;
  showBuzzTopUp?: boolean;
  containerSize?: 'sm' | 'md' | 'lg' | 'xl';
  reason?: JoinRedirectReason;
  children: ReactNode;
}

export function MembershipPageWrapper({
  title,
  introText = "As the leading generative AI community, we're adding new features every week. Help us keep the community thriving by becoming a Supporter and get exclusive perks.",
  showBuzzTopUp = false,
  containerSize = 'xl',
  reason,
  children,
}: MembershipPageWrapperProps) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const redirectReason = reason ? joinRedirectReasons[reason] : undefined;
  const isHolidays = isHolidaysTime();

  return (
    <>
      <Meta
        title="Memberships | Civitai"
        description="As the leading generative AI community, we're adding new features every week. Help us keep the community thriving by becoming a Supporter and get exclusive perks."
      />
      <Container size={containerSize}>
        <Stack>
          {/* Redirect reason alert */}
          {!!redirectReason && (
            <Alert color="yellow">
              <Group gap="xs" wrap="nowrap" align="flex-start">
                <ThemeIcon color="yellow">
                  <IconExclamationMark />
                </ThemeIcon>
                <Text size="md">{redirectReason}</Text>
              </Group>
            </Alert>
          )}

          {/* Holiday banner */}
          {isHolidays && !redirectReason && (
            <Alert color="blue">
              <div className="flex flex-col items-center gap-4 md:flex-row">
                <Image
                  src="/images/holiday/happy-holidays-robot.png"
                  alt="happy-holidays"
                  width={150}
                  height={150}
                  className="hidden rounded-md md:block"
                />
                <Stack gap="xs">
                  <Text size="md">
                    To celebrate the holidays and our amazing community, new subscribers and current
                    members alike will receive 20% additional Blue Buzz along with their standard
                    Buzz disbursement!
                  </Text>
                  <Text size="md">
                    This bonus applies when a new membership is purchased or an active membership
                    renews.
                  </Text>
                  <Text size="md">Happy Holidays from Civitai!</Text>
                </Stack>
              </div>
            </Alert>
          )}

          {/* Title and intro text */}
          <Title className={clsx(classes.title, 'text-center')}>{title}</Title>
          {introText && (
            <Text align="center" className={classes.introText} style={{ lineHeight: 1.25 }}>
              {introText}
            </Text>
          )}

          {/* Payment alerts */}
          {features.disablePayments && !features.prepaidMemberships && (
            <Center>
              <AlertWithIcon
                color="red"
                iconColor="red"
                icon={<IconInfoTriangleFilled size={20} strokeWidth={2.5} />}
                iconSize={28}
                py={11}
                maw="calc(50% - 8px)"
              >
                <Stack gap={0}>
                  <Text size="xs" lh={1.2}>
                    Purchasing or updating memberships is currently disabled. We are working hard to
                    resolve this and will notify you when it is back up. You can still manage your
                    active membership, and your benefits will be active until your
                    membership&rsquo;s expiration date.{' '}
                    <Anchor href="https://civitai.com/articles/14945" c="red.3">
                      Learn more
                    </Anchor>
                  </Text>
                </Stack>
              </AlertWithIcon>
            </Center>
          )}

          {/* Prepaid memberships promo banner */}
          {features.disablePayments && features.prepaidMemberships && (
            <Center>
              <PromoBanner
                icon={<IconInfoCircle size={24} />}
                title="Prepaid Memberships Available!"
                subtitle="Regular membership purchases are temporarily disabled, but you can still
                      purchase prepaid memberships! Prepaid memberships give you all the same
                      benefits and can be stacked up!"
                buyNowHref="/gift-cards?type=memberships"
                buyNowText="Purchase Now!"
              />
            </Center>
          )}

          {/* Buzz top-up card */}
          {showBuzzTopUp && currentUser && (
            <Center>
              <BuzzTopUpCard
                accountId={currentUser?.id}
                variant="banner"
                message="Looking for Buzz Bundles?"
                showBalance={false}
                btnLabel="Purchase now"
              />
            </Center>
          )}

          {/* Main content */}
          {children}
        </Stack>
      </Container>
    </>
  );
}
