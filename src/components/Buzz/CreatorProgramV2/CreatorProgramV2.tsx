import { ActionIcon, Alert, Anchor, Badge, Button, Divider, Loader, Tooltip } from '@mantine/core';
import {
  IconCalendar,
  IconCircleCheck,
  IconCircleX,
  IconInfoCircle,
  IconPigMoney,
  IconUxCircle,
} from '@tabler/icons-react';
import clsx from 'clsx';
import React, { HTMLProps } from 'react';
import {
  useBankedBuzz,
  useCompensationPool,
  useCreatorProgramForecast,
  useCreatorProgramMutate,
  useCreatorProgramPhase,
  useCreatorProgramRequirements,
} from '~/components/Buzz/CreatorProgramV2/CreatorProgram.util';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import AlertDialog from '~/components/Dialog/Common/AlertDialog';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { NextLink } from '~/components/NextLink/NextLink';
import { useRefreshSession } from '~/components/Stripe/memberships.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { OnboardingSteps } from '~/server/common/enums';
import { getCurrentValue, getForecastedValue } from '~/server/utils/creator-program.utils';
import { Flags } from '~/shared/utils';
import { Currency } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { abbreviateNumber, formatToLeastDecimals, numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';

const cardProps: HTMLProps<HTMLDivElement> = {
  className: 'light:bg-gray-0 align-center flex flex-col rounded-lg p-4 dark:bg-dark-5',
};

const openPhasesModal = () => {
  dialogStore.trigger({
    component: AlertDialog,
    props: {
      title: 'Creator Program Phases',
      type: 'info',
      size: 'lg',
      children: ({ handleClose }) => (
        <div className="flex flex-col gap-4">
          <p>Every month the Creator Program has two phases.</p>

          <div className="flex flex-col gap-2">
            <h3 className="text-xl font-bold">Banking Phase</h3>
            <p>
              During this phase creators can Bank any Yellow Buzz they&rsquo;ve earned. This phase
              continues until 3 days before the end of the month (UTC). As the month continues the
              value of the Buzz you&rsquo;ve Banked will <span className="font-bold">decrease</span>{' '}
              in value as the total Buzz in the Bank increases.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-xl font-bold">Extraction Phase</h3>
            <p>
              During this phase creators Bank Buzz is disabled, instead creators can review the
              value of the piece of the Compensation Pool and determine if they want to keep their
              Buzz in the Bank or Extract it to get it back for a future month or to use on Civitai.
              This phase starts the last 3 days of the month and ends 1 hour before the end of the
              month (UTC). As this phase continues the value of the Buzz you&rsquo;ve Banked will{' '}
              <span className="font-bold">increase</span> in value as creators Extract Buzz from the
              Bank, making your share of the pool bigger!
            </p>
          </div>
          <Button onClick={handleClose}>Close</Button>
        </div>
      ),
    },
  });
};
const openEarningEstimateModal = () => {
  dialogStore.trigger({
    component: AlertDialog,
    props: {
      title: 'How does this work?',
      type: 'info',
      children: ({ handleClose }) => (
        <div className="flex flex-col gap-4">
          <p>
            This is a forecasted value determined by estimating that a portion of all active
            creators will bank their earnings for the month. The dollar value you receive will vary
            depending on the amount of Buzz Banked by all creators at the end of the month. If
            you&rsquo;re unsatisfied with the money you&rsquo;ll receive, you can get it back during
            the 3 day Extraction Phase at the end of the month.{' '}
          </p>
          <Button onClick={handleClose}>Close</Button>
        </div>
      ),
    },
  });
};

export const CreatorsProgramV2 = () => {
  const currentUser = useCurrentUser();
  const { phase, isLoading } = useCreatorProgramPhase();

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
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-bold">Get Paid</h2>
          <CreatorProgramPhase />
        </div>
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
          {phase === 'bank' && <BankBuzzCard />}
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
  const hasEnoughCreatorScore =
    (requirements?.score.current ?? 0) >= (requirements?.score.min ?? 0);
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
          <ActionIcon onClick={openEarningEstimateModal}>
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
  const { compensationPool, isLoading: isLoadingCompensationPool } = useCompensationPool();
  const buzzAccount = useBuzz(undefined, 'user');
  const { bankBuzz, bankingBuzz } = useCreatorProgramMutate();

  const [toBank, setToBank] = React.useState<number>(10000);
  const forecasted = compensationPool ? getForecastedValue(toBank, compensationPool) : undefined;
  const isLoading = isLoadingCompensationPool || buzzAccount.balanceLoading;
  const [_, end] = compensationPool?.phases.bank ?? [new Date(), new Date()];
  const endDate = formatDate(end, 'MMM D, YYYY @ hA [UTC]');

  const handleBankBuzz = async () => {
    try {
      await bankBuzz({ amount: toBank });
      showSuccessNotification({
        title: 'Success!',
        message: 'You have successfully banked your Buzz.',
      });

      setToBank(10000);
    } catch (error) {
      // no-op. The mutation should handle it.
    }
  };

  if (isLoading) {
    return (
      <div className={clsx(cardProps.className, 'basis-1/4')}>
        <Loader className="m-auto" />
      </div>
    );
  }

  return (
    <div className={clsx(cardProps.className, 'basis-1/4 gap-6')}>
      <div className="flex h-full flex-col gap-2">
        <h3 className="text-xl font-bold">Bank Buzz Card</h3>
        <p className="text-sm">Claim your piece of the pool by banking your Buzz!</p>

        <div className="flex">
          <NumberInputWrapper
            label="Buzz"
            labelProps={{ className: 'hidden' }}
            icon={<CurrencyIcon currency={Currency.BUZZ} size={18} />}
            value={toBank ? toBank : undefined}
            min={10000}
            max={buzzAccount.balance}
            onChange={(value) => {
              setToBank(value ?? 10000);
            }}
            styles={{
              input: {
                borderTopRightRadius: 0,
                borderBottomRightRadius: 0,
                border: 0,
              },
            }}
            step={1000}
          />
          <Tooltip label="Bank now!" position="top">
            <ActionIcon
              miw={40}
              variant="filled"
              color="lime.7"
              className="rounded-l-none"
              h="100%"
              loading={bankingBuzz}
              onClick={() => {
                dialogStore.trigger({
                  component: ConfirmDialog,
                  props: {
                    title: 'Bank your Buzz',
                    message: (
                      <div className="flex flex-col gap-2">
                        <p>
                          You are about to add{' '}
                          <CurrencyBadge unitAmount={toBank} currency={Currency.BUZZ} /> to the
                          bank.{' '}
                        </p>
                        <p> Are you sure?</p>
                      </div>
                    ),
                    labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
                    onConfirm: handleBankBuzz,
                  },
                });
              }}
            >
              <IconPigMoney size={24} />
            </ActionIcon>
          </Tooltip>
        </div>
        <Button
          compact
          size="xs"
          variant="outline"
          disabled={toBank === buzzAccount.balance}
          onClick={() => setToBank(buzzAccount.balance)}
        >
          Max
        </Button>

        <div className="mb-2 flex items-center gap-2">
          <p className="text-sm">
            <span className="font-bold">Estimated Value:</span> $
            {numberWithCommas(formatToLeastDecimals(forecasted ?? 0))}
          </p>
          <ActionIcon onClick={openEarningEstimateModal}>
            <IconInfoCircle size={14} />
          </ActionIcon>
        </div>

        <Alert color="yellow" className="mt-auto px-2">
          <div className="flex items-center gap-2">
            <IconCalendar size={24} className="shrink-0" />
            <div className="flex flex-1 flex-col">
              <p className="font-bold">Banking Phase Ends</p>
              <p className="text-nowrap text-xs">{endDate}</p>
            </div>
            <ActionIcon onClick={openPhasesModal}>
              <IconInfoCircle size={18} />
            </ActionIcon>
          </div>
        </Alert>
      </div>
    </div>
  );
};

const EstimatedEarningsCard = () => {
  const { compensationPool, isLoading: isLoadingCompensationPool } = useCompensationPool();
  const { phase } = useCreatorProgramPhase();
  const { banked, isLoading: isLoadingBanked } = useBankedBuzz();
  const isLoading = isLoadingCompensationPool || isLoadingBanked;
  const cap = banked?.cap.cap;
  const currentBanked = banked?.total ?? 0;
  const isCapped = cap && cap <= currentBanked;

  if (isLoading || !compensationPool || !banked) {
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

        <table className="table-auto">
          <tbody>
            <tr>
              <td>Compensation Pool</td>
              <td>&nbsp;</td>
              <td className="border-l-4 py-1 pl-2">${numberWithCommas(compensationPool?.value)}</td>
            </tr>
            <tr>
              <td>Total Banked Buzz</td>
              <td>&nbsp;</td>
              <td className="border-l-4 py-1 pl-2">
                <div className="flex items-center gap-2">
                  <CurrencyIcon currency={Currency.BUZZ} size={16} />
                  <span>{numberWithCommas(compensationPool?.size.current)}</span>
                </div>
              </td>
            </tr>
            <tr>
              <td>Your Banked Buzz</td>
              <td className="text-right">
                {cap && (
                  <Anchor
                    onClick={() => {
                      console.log('TODO');
                    }}
                    className="pr-2 text-sm "
                  >
                    {abbreviateNumber(cap)} Cap
                  </Anchor>
                )}
              </td>
              <td className="border-l-4 py-1 pl-2">
                <div className="flex items-center gap-2">
                  <CurrencyIcon currency={Currency.BUZZ} size={16} />
                  <span>{numberWithCommas(banked.total)}</span>
                  {isCapped && (
                    <Badge color="yellow" size="sm">
                      Capped
                    </Badge>
                  )}
                </div>{' '}
              </td>
            </tr>
          </tbody>
        </table>

        <Divider my="sm" />

        <div className="mb-4 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <p className="text-lg">
              <span className="font-bold">Current Value:</span> $
              {compensationPool
                ? numberWithCommas(getCurrentValue(banked.total ?? 0, compensationPool))
                : 'N/A'}
            </p>
            <ActionIcon onClick={openEarningEstimateModal}>
              <IconInfoCircle size={14} />
            </ActionIcon>
          </div>
          {phase === 'bank' && (
            <p className="text-xs">
              This value will <span className="font-bold">decrease</span> as other creators Extract
              Buzz. <span className="font-bold">Forecasted value: </span> $
              {numberWithCommas(getForecastedValue(banked.total ?? 0, compensationPool))}
            </p>
          )}
          {phase === 'extraction' && (
            <p className="text-xs">
              This value will <span className="font-bold">increase</span> as other creators Extract
              Buzz.
            </p>
          )}
        </div>

        {phase === 'bank' && (
          <div className="flex flex-col gap-0">
            <p className="text-sm font-bold"> Not happy with your estimated earnings?</p>
            <p className="text-sm">
              You can Extract Buzz during the{' '}
              <Anchor onClick={openPhasesModal}>Extraction Phase</Anchor>:
            </p>
            <p className="text-sm">
              {formatDate(compensationPool.phases.extraction[0], 'MMM D, YYYY @ hA [UTC]')} &ndash;{' '}
              {formatDate(compensationPool.phases.extraction[1], 'MMM D, YYYY @ hA [UTC]')}
            </p>
          </div>
        )}
        {phase === 'extraction' && (
          <div className="flex flex-col gap-0">
            <p className="text-sm font-bold"> Not happy with your estimated earnings?</p>
            <p className="text-sm">
              You can Extract Buzz your Buzz until{' '}
              {formatDate(compensationPool.phases.extraction[1], 'MMM D, YYYY @ hA [UTC]')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export const CreatorProgramPhase = () => {
  const { phase, isLoading } = useCreatorProgramPhase();

  if (isLoading || !phase) {
    return null;
  }

  const Icon = phase === 'bank' ? IconPigMoney : IconUxCircle;
  const color = phase === 'bank' ? 'green' : 'yellow';

  return (
    <Badge leftSection={<Icon size={18} />} color={color} className="capitalize">
      {phase === 'bank' ? 'Banking' : 'Extraction'} Phase
    </Badge>
  );
};
