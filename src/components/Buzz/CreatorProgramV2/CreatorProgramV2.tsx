import { ActionIcon, Anchor, Button, Divider, Loader } from '@mantine/core';
import { IconCircleCheck, IconCircleX, IconInfoCircle, IconUxCircle } from '@tabler/icons-react';
import clsx from 'clsx';
import React, { HTMLProps } from 'react';
import {
  useCompensationPool,
  useCreatorProgramForecast,
  useCreatorProgramMutate,
  useCreatorProgramRequirements,
} from '~/components/Buzz/CreatorProgramV2/CreatorProgram.util';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import AlertDialog from '~/components/Dialog/Common/AlertDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { NextLink } from '~/components/NextLink/NextLink';
import { useRefreshSession } from '~/components/Stripe/memberships.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { OnboardingSteps } from '~/server/common/enums';
import { Flags } from '~/shared/utils';
import { Currency } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { abbreviateNumber, formatToLeastDecimals, numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';

const cardProps: HTMLProps<HTMLDivElement> = {
  className: 'light:bg-gray-0 align-center flex flex-col rounded-lg p-4 dark:bg-dark-5',
};

export const CreatorsProgramV2 = () => {
  const currentUser = useCurrentUser();

  if (!currentUser) {
    return null;
  }

  const hasOnboardedInProgram = Flags.hasFlag(
    currentUser.onboarding,
    OnboardingSteps.CreatorProgram
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-bold">Get Paid</h2>
        <div className="flex gap-2">
          <p>Generating a lot of Buzz? Bank it to earn cash!</p>
          <Anchor href="/creators-program">Learn more</Anchor>
        </div>
      </div>

      {!hasOnboardedInProgram && <JoinCreatorProgramCard />}
      {hasOnboardedInProgram && (
        <div className="flex gap-4">
          <CompensationPoolCard />
          <EstimatedEarningsCard />
          <BankBuzzCard />
        </div>
      )}
    </div>
  );
};

const JoinCreatorProgramCard = () => {
  const buzzAccount = useBuzz(undefined, 'user');
  const { requirements, isLoading: isLoadingRequirements } = useCreatorProgramRequirements();
  const { forecast, isLoading: isLoadingForecast } = useCreatorProgramForecast({
    buzz: buzzAccount.balance,
  });
  const { joinCreatorsProgram, joiningCreatorsProgram } = useCreatorProgramMutate();
  const isLoading = buzzAccount.balanceLoading || isLoadingRequirements || isLoadingForecast;

  const membership = requirements?.membership;
  const hasEnoughCreatorScore = requirements?.score.current >= requirements?.score.min;
  const { refreshSession, refreshing } = useRefreshSession(false);

  const handleJoinCreatorsProgram = async () => {
    try {
      await joinCreatorsProgram();
      showSuccessNotification({
        title: 'Success!',
        message: 'You have successfully joined the Creators Program.',
      });
      refreshSession();
    } catch (error) {
      // no-op. The mutation should handle it.
    }
  };

  if (isLoading) {
    return (
      <div className={clsx(cardProps.className, 'basis-full')}>
        <Loader className="m-auto" />
      </div>
    );
  }

  return (
    <div className={clsx(cardProps.className, 'basis-full gap-6')}>
      <div className="flex flex-col gap-2">
        <h3 className="text-xl font-bold">Join the Creators Program</h3>

        <div className="flex gap-1">
          <p>
            Your{' '}
            <CurrencyBadge
              currency={Currency.BUZZ}
              unitAmount={buzzAccount.balance}
              formatter={abbreviateNumber}
            />{' '}
            could be worth{' '}
            <span className="font-bold text-yellow-6">
              ${numberWithCommas(formatToLeastDecimals(forecast.forecastedEarning))}
            </span>
            !
          </p>
          <ActionIcon
            onClick={() => {
              dialogStore.trigger({
                component: AlertDialog,
                props: {
                  title: 'How does this work?',
                  type: 'info',
                  children: ({ handleClose }) => (
                    <div className="flex flex-col gap-4">
                      <p className="text-justify">
                        This is a forecasted value determined by estimating that a portion of all
                        active creators will bank their earnings for the month. The dollar value you
                        receive will vary depending on the amount of Buzz Banked by all creators at
                        the end of the month. If you&rsquo;re unsatisfied with the money
                        you&rsquo;ll receive, you can get it back during the 3 day Extraction Phase
                        at the end of the month.{' '}
                      </p>
                      <Button onClick={handleClose}>Close</Button>
                    </div>
                  ),
                },
              });
            }}
          >
            <IconInfoCircle size={14} />
          </ActionIcon>
        </div>
      </div>

      <div className="  flex flex-col gap-2">
        <p className="font-bold">Program requirements</p>
        <Divider />

        <div className="flex gap-4">
          <CreatorProgramRequirement
            isMet={hasEnoughCreatorScore}
            title={`Have a creator score higher than ${abbreviateNumber(
              requirements?.score.min ?? 10000
            )}`}
            content={
              <p>
                Your current{' '}
                <Anchor
                  onClick={() => {
                    dialogStore.trigger({
                      component: AlertDialog,
                      props: {
                        title: 'What is your Creator Score?',
                        type: 'info',
                        children: ({ handleClose }) => (
                          <div className="align-center flex flex-col gap-4">
                            <p className="text-center">
                              Creator Score is a value that we compute behind the scenes based on
                              your activity within the Civitai community and engagement with content
                              and models that you&rsquo;ve created.
                            </p>
                            <Button onClick={handleClose}>Close</Button>
                          </div>
                        ),
                      },
                    });
                  }}
                >
                  Creator Score
                </Anchor>{' '}
                is {abbreviateNumber(requirements?.score.current ?? 0)}.
              </p>
            }
          />
          <CreatorProgramRequirement
            isMet={!!membership}
            title="Be a Civitai Member"
            content={
              membership ? (
                <p>
                  You are a {getDisplayName(membership as string)} member! Thank you for supporting
                  Civitai.
                </p>
              ) : (
                <NextLink href="/pricing">Become a Civitai Member Now!</NextLink>
              )
            }
          />
        </div>
      </div>
      <Button
        disabled={!hasEnoughCreatorScore || !membership}
        onClick={() => {
          handleJoinCreatorsProgram();
        }}
        loading={joiningCreatorsProgram || refreshing}
      >
        Join the Creators Program
      </Button>
    </div>
  );
};

const CreatorProgramRequirement = ({
  title,
  content,
  isMet,
}: {
  title: string;
  content: string | React.ReactNode;
  isMet: boolean;
}) => {
  return (
    <div className="flex gap-2">
      {isMet ? (
        <IconCircleCheck className="text-green-500" size={25} />
      ) : (
        <IconCircleX className="text-red-500" size={25} />
      )}
      <div className="flex flex-col gap-0">
        <p className="font-bold">{title}</p>
        {typeof content === 'string' ? <p>{content}</p> : content}
      </div>
    </div>
  );
};

const CompensationPoolCard = () => {
  const { compensationPool, isLoading: isLoadingCompensationPool } = useCompensationPool();
  const isLoading = isLoadingCompensationPool;
  const date = formatDate(compensationPool?.phases.bank[0] ?? new Date(), 'MMMM, YYYY');

  if (isLoading) {
    return (
      <div className={clsx(cardProps.className, 'basis-1/4')}>
        <Loader className="m-auto" />
      </div>
    );
  }

  console.log(compensationPool);

  return (
    <div className={clsx(cardProps.className, 'basis-1/4 gap-6')}>
      <div className="flex flex-col justify-center gap-12">
        <h3 className="text-center text-xl font-bold">Compensation Pool</h3>

        <div className="flex flex-col gap-1">
          <p className="text-center">{date}</p>
          <p className="text-center text-2xl font-bold">
            ${numberWithCommas(compensationPool?.value)}
          </p>
        </div>
        <Anchor
          onClick={() => {
            dialogStore.trigger({
              component: AlertDialog,
              props: {
                title: 'Compensation pool',
                type: 'info',
                children: ({ handleClose }) => (
                  <div className="flex flex-col justify-center gap-4">
                    <p className="text-center">
                      The Creator Program Compensation Pool is 10% of the revenue Civitai brought in
                      last month. That means the pool grows as we do! The more active creators there
                      are attracting people that spend Buzz, the bigger the pool will be the next
                      month.
                    </p>
                    <Button onClick={handleClose}>Close</Button>
                  </div>
                ),
              },
            });
          }}
        >
          <div className="flex items-center justify-center gap-2">
            <IconInfoCircle size={14} />
            <p>How is this determined?</p>
          </div>
        </Anchor>
      </div>
    </div>
  );
};

const BankBuzzCard = () => {
  const { forecast, isLoading: isLoadingForecast } = useCreatorProgramForecast();
  const isLoading = isLoadingForecast;

  if (isLoading) {
    return (
      <div className={clsx(cardProps.className, 'basis-1/4')}>
        <Loader className="m-auto" />
      </div>
    );
  }

  return (
    <div className={clsx(cardProps.className, 'basis-1/4 gap-6')}>
      <div className="flex flex-col gap-2">
        <h3 className="text-xl font-bold">Bank Buzz Card</h3>
      </div>
    </div>
  );
};

const EstimatedEarningsCard = () => {
  const { forecast, isLoading: isLoadingForecast } = useCreatorProgramForecast();
  const isLoading = isLoadingForecast;

  if (isLoading) {
    return (
      <div className={clsx(cardProps.className, 'basis-2/4')}>
        <Loader className="m-auto" />
      </div>
    );
  }

  return (
    <div className={clsx(cardProps.className, 'basis-2/4 gap-6')}>
      <div className="flex flex-col gap-2">
        <h3 className="text-xl font-bold">Estimated Earnings</h3>
      </div>
    </div>
  );
};
