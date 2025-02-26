import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Divider,
  Loader,
  Modal,
  Table,
  Tooltip,
} from '@mantine/core';
import {
  IconBuildingBank,
  IconCalendar,
  IconCircleCheck,
  IconCircleX,
  IconHistory,
  IconInfoCircle,
  IconLock,
  IconLogout,
  IconLogout2,
  IconPigMoney,
  IconUxCircle,
} from '@tabler/icons-react';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { capitalize } from 'lodash-es';
import React, { HTMLProps, useEffect } from 'react';
import {
  useBankedBuzz,
  useCompensationPool,
  useCreatorPoolListener,
  useCreatorProgramForecast,
  useCreatorProgramMutate,
  useCreatorProgramPhase,
  useCreatorProgramRequirements,
  useUserCash,
  useWithdrawalHistory,
} from '~/components/Buzz/CreatorProgramV2/CreatorProgram.util';
import {
  openEarningEstimateModal,
  openExtractionFeeModal,
  openPhasesModal,
  openSettlementModal,
  openWithdrawalFreeModal,
} from '~/components/Buzz/CreatorProgramV2/CreatorProgramV2.modals';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { Countdown } from '~/components/Countdown/Countdown';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import AlertDialog from '~/components/Dialog/Common/AlertDialog';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { NextLink } from '~/components/NextLink/NextLink';
import { useRefreshSession } from '~/components/Stripe/memberships.util';
import { TosModal } from '~/components/ToSModal/TosModal';
import { useUserPaymentConfiguration } from '~/components/UserPaymentConfiguration/util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { OnboardingSteps } from '~/server/common/enums';
import {
  getCurrentValue,
  getExtractionFee,
  getForecastedValue,
} from '~/server/utils/creator-program.utils';
import {
  CAP_DEFINITIONS,
  MIN_WITHDRAWAL_AMOUNT,
  WITHDRAWAL_FEES,
} from '~/shared/constants/creator-program.constants';
import { Flags } from '~/shared/utils';
import { CashWithdrawalMethod, Currency } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import {
  abbreviateNumber,
  formatCurrencyForDisplay,
  formatPriceForDisplay,
  formatToLeastDecimals,
  numberWithCommas,
} from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';

const cardProps: HTMLProps<HTMLDivElement> = {
  className: 'light:bg-gray-0 align-center flex flex-col rounded-lg p-4 dark:bg-dark-5',
};

// TODO creators program Can probably separate this file into multiple smaller ones. It's getting a bit long.
export const CreatorsProgramV2 = () => {
  const currentUser = useCurrentUser();
  const { phase, isLoading } = useCreatorProgramPhase();
  useCreatorPoolListener();

  if (!currentUser || isLoading) {
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
        <div className="flex flex-col gap-4 md:flex-row">
          <CompensationPoolCard />
          <EstimatedEarningsCard />
          {phase === 'bank' && <BankBuzzCard />}
          {phase === 'extraction' && <ExtractBuzzCard />}
          {<WithdrawCashCard />}
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

  const hasValidMembership = requirements?.validMembership;
  const membership = requirements?.membership;
  const hasEnoughCreatorScore =
    (requirements?.score.current ?? 0) >= (requirements?.score.min ?? 0);
  const { refreshSession, refreshing } = useRefreshSession(false);

  const handleJoinCreatorsProgram = async () => {
    dialogStore.trigger({
      component: TosModal,
      props: {
        slug: 'creator-program-v2-tos',
        key: 'creatorProgramToSAccepted' as any,
        onAccepted: async () => {
          try {
            await joinCreatorsProgram();
            showSuccessNotification({
              title: 'Success!',
              message: 'You have successfully joined the Creator Program.',
            });
            refreshSession();
          } catch (error) {
            // no-op. The mutation should handle it.
          }
        },
      },
    });
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
        <h3 className="text-xl font-bold">Join the Creator Program</h3>

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
            title={`Have a Creator Score higher than ${abbreviateNumber(
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
                          <div className="flex flex-col justify-center gap-4">
                            <p className="text-center">
                              Creator Score is a value we calculate based on your participation in
                              the Civitai community, including your activity and how others engage
                              with the content and models you create.
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
              hasValidMembership ? (
                <p>
                  You are a {capitalize(getDisplayName(membership as string))} Member! Thank you for
                  supporting Civitai.
                </p>
              ) : membership ? (
                <p>
                  You are a {capitalize(getDisplayName(membership as string))} Member. Your current
                  membership does not apply to join the Creator Program. Consider upgrading to one
                  our supported memberships.
                  <br />
                  <NextLink href="/pricing">
                    <Anchor>Upgrade Membership</Anchor>
                  </NextLink>
                </p>
              ) : (
                <NextLink href="/pricing">
                  <Anchor>Become a Civitai Member Now!</Anchor>
                </NextLink>
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
        Join the Creator Program
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
      <div className="flex h-full flex-col justify-between gap-12">
        <h3 className="text-center text-xl font-bold">Compensation Pool</h3>

        <div className="flex flex-col gap-1">
          <p className="text-center">{date}</p>
          <p className="text-center text-2xl font-bold">
            ${numberWithCommas(formatToLeastDecimals(compensationPool?.value ?? 0))}
          </p>
        </div>
        <Anchor
          onClick={() => {
            dialogStore.trigger({
              component: AlertDialog,
              props: {
                title: 'Compensation Pool',
                type: 'info',
                children: ({ handleClose }) => (
                  <div className="flex flex-col justify-center gap-4">
                    <p>
                      The Creator Program Compensation Pool is made up of a portion of
                      Civitai&rsquo;s revenue from the previous month. As Civitai grows, so does the
                      pool! The more active Creators there are attracting users who spend Buzz, the
                      larger the pool will be the next month
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
  const { banked, isLoading: isLoadingBanked } = useBankedBuzz();
  const buzzAccount = useBuzz(undefined, 'user');
  const { bankBuzz, bankingBuzz } = useCreatorProgramMutate();

  const [toBank, setToBank] = React.useState<number>(10000);
  const forecasted = compensationPool ? getForecastedValue(toBank, compensationPool) : undefined;
  const isLoading = isLoadingCompensationPool || buzzAccount.balanceLoading || isLoadingBanked;
  const [_, end] = compensationPool?.phases.bank ?? [new Date(), new Date()];
  const endDate = formatDate(end, 'MMM D, YYYY @ hA [UTC]');
  const shouldUseCountdown = new Date() > dayjs(end).subtract(2, 'day').toDate();

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

  const maxBankable = banked?.cap?.cap
    ? Math.min(banked.cap.cap - banked.total, buzzAccount.balance)
    : buzzAccount.balance;

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
        <h3 className="text-xl font-bold">Bank Buzz</h3>
        <p className="text-sm">Claim your piece of the pool by banking your Buzz!</p>

        <div className="flex">
          <NumberInputWrapper
            label="Buzz"
            labelProps={{ className: 'hidden' }}
            icon={<CurrencyIcon currency={Currency.BUZZ} size={18} />}
            value={toBank ? toBank : undefined}
            min={10000}
            max={maxBankable}
            onChange={(value) => {
              setToBank(Math.min(value ?? 10000, maxBankable));
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
          disabled={toBank === maxBankable}
          onClick={() => setToBank(maxBankable)}
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
              <p className="text-nowrap font-bold">Banking Phase Ends</p>
              <p className="text-nowrap text-xs">
                {shouldUseCountdown ? <Countdown endTime={end} /> : endDate}
              </p>
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
              <td className="border-l-2 py-1 pl-2">
                ${numberWithCommas(formatToLeastDecimals(compensationPool?.value ?? 0))}
              </td>
            </tr>
            <tr>
              <td>Total Banked Buzz</td>
              <td>&nbsp;</td>
              <td className="border-l-2 py-1 pl-2">
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
                      dialogStore.trigger({
                        component: CreatorProgramCapsInfo,
                      });
                    }}
                    className="pr-2 text-sm "
                  >
                    {abbreviateNumber(cap)} Cap
                  </Anchor>
                )}
              </td>
              <td className="border-l-2 py-1 pl-2">
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
              This value will <span className="font-bold">decrease</span> as other creators Bank
              Buzz. <span className="font-bold">Forecasted value: </span> $
              {numberWithCommas(
                formatToLeastDecimals(getForecastedValue(banked.total ?? 0, compensationPool))
              )}
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
              You can extract Buzz during the{' '}
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
              You can extract Buzz your Buzz until{' '}
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

  const Icon = phase === 'bank' ? IconPigMoney : IconLogout2;
  const color = phase === 'bank' ? 'green' : 'yellow';

  return (
    <Badge leftSection={<Icon size={18} />} color={color} className="capitalize">
      {phase === 'bank' ? 'Banking' : 'Extraction'} Phase
    </Badge>
  );
};

const CreatorProgramCapsInfo = () => {
  const { banked, isLoading } = useBankedBuzz();
  const dialog = useDialogContext();

  if (isLoading || !banked) {
    return null;
  }

  const nextCap = CAP_DEFINITIONS.find(
    (c) =>
      (!c.limit ||
        banked.cap.cap < banked.cap.peakEarning.earned * (c.percentOfPeakEarning ?? 1)) &&
      c.tier !== banked.cap.definition.tier
  );

  const potentialEarnings =
    nextCap && banked.cap.peakEarning.earned * (nextCap.percentOfPeakEarning ?? 1);

  return (
    <Modal {...dialog} title="Creator Banking Caps" size="lg" radius="md">
      <div className="flex flex-col gap-4">
        <p>
          Every creator in the program has a Cap to the amount of Buzz they can Bank in a month.
          Caps align with membership tiers as outlined below.
        </p>

        <Table className="table-auto">
          <thead>
            <tr>
              <th>Tier</th>
              <th>Cap</th>
            </tr>
          </thead>
          <tbody>
            {CAP_DEFINITIONS.map((cap) => {
              if (cap.hidden) {
                return null;
              }

              return (
                <tr key={cap.tier}>
                  <td className="font-bold">{capitalize(cap.tier)} Member</td>
                  <td>
                    <p>
                      {cap.percentOfPeakEarning
                        ? `${cap.percentOfPeakEarning * 100}% of your Peak Earning Month with `
                        : ''}

                      {!cap.limit ? (
                        'no cap'
                      ) : cap.percentOfPeakEarning ? (
                        <span>
                          a <CurrencyIcon currency={Currency.BUZZ} className="inline" />
                          {abbreviateNumber(cap.limit)} cap
                        </span>
                      ) : (
                        <span>
                          <CurrencyIcon currency={Currency.BUZZ} className="inline" />
                          {abbreviateNumber(cap.limit)}
                        </span>
                      )}
                    </p>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>

        <div className="flex flex-col gap-1">
          <p>
            <span className="font-bold">Your Cap:</span> {capitalize(banked.cap.definition.tier)}{' '}
            Member
          </p>
          <p>
            <span className="font-bold">Peak Earning Month:</span>{' '}
            <CurrencyIcon currency={Currency.BUZZ} className="inline" />
            {abbreviateNumber(banked.cap.peakEarning.earned)}{' '}
            <span className="opacity-50">
              ({formatDate(banked.cap.peakEarning.month, 'MMM YYYY')})
            </span>
          </p>
          <p>
            <span className="font-bold">Tier Cap:</span>{' '}
            <CurrencyIcon currency={Currency.BUZZ} className="inline" />
            {banked.cap.definition.limit ? numberWithCommas(banked.cap.definition.limit) : 'No Cap'}
          </p>
        </div>

        {nextCap && (
          <p>
            You could increase your cap to{' '}
            <CurrencyIcon currency={Currency.BUZZ} className="inline" />{' '}
            {numberWithCommas(potentialEarnings)} by upgrading to a {capitalize(nextCap.tier)}{' '}
            Membership.{' '}
            <Anchor className="text-nowrap" href="/pricing" onClick={dialog.onClose}>
              Upgrade Now
            </Anchor>
          </p>
        )}
      </div>
    </Modal>
  );
};

const WithdrawCashCard = () => {
  const { userCash, isLoading: isLoadingCash } = useUserCash();
  const { withdrawCash, withdrawingCash } = useCreatorProgramMutate();
  const { userPaymentConfiguration, isLoading: isLoadingPaymentConfiguration } =
    useUserPaymentConfiguration();

  const [toWithdraw, setToWithdraw] = React.useState<number>(MIN_WITHDRAWAL_AMOUNT);

  const isLoading = isLoadingCash || isLoadingPaymentConfiguration;

  useEffect(() => {
    if (userCash && userCash.ready) {
      setToWithdraw(Math.max(userCash.ready, MIN_WITHDRAWAL_AMOUNT));
    }
  }, [userCash]);

  const handleWithdrawal = async () => {
    try {
      await withdrawCash({ amount: toWithdraw });
      showSuccessNotification({
        title: 'Success!',
        message: 'You have successfully created a cash transaction.',
      });

      setToWithdraw(MIN_WITHDRAWAL_AMOUNT);
    } catch (error) {
      // no-op. The mutation should handle it.
    }
  };

  const handleSetupWithdrawals = () => {
    if (userPaymentConfiguration?.tipaltiPaymentsEnabled) {
      return;
    }

    if (userPaymentConfiguration) {
      window.open('/tipalti/setup', '_blank');
      return;
    }

    // TODO: Attempt to setup Tipalti account from this button.
    // This would also come from a job so there might not be a need for this.
  };

  if (isLoading) {
    return (
      <div className={clsx(cardProps.className, 'basis-1/4')}>
        <Loader className="m-auto" />
      </div>
    );
  }

  if (!userCash) {
    return null; // Failed to load.
  }

  const canWithdraw =
    (userCash?.ready ?? 0) > MIN_WITHDRAWAL_AMOUNT || (userCash?.withdrawn ?? 0) > 0;

  return (
    <div className={clsx(cardProps.className, 'basis-1/4 gap-6')}>
      <div className="flex h-full flex-col gap-2">
        <h3 className="text-xl font-bold">Withdraw Cash</h3>
        <p className="text-sm">Once you&rsquo;ve earned cash, you can withdraw it to your bank</p>
        <table className="mb-4 table-auto text-sm">
          <tbody>
            <tr>
              <td>
                <div className="flex items-center gap-2">
                  <span>Pending Settlement </span>
                  <ActionIcon onClick={openSettlementModal}>
                    <IconInfoCircle size={14} />
                  </ActionIcon>
                </div>
              </td>
              <td className="border-l-2 py-1 pl-2">
                <div className="flex items-center gap-2">
                  $<span>{formatCurrencyForDisplay(userCash?.pending ?? 0, Currency.USD)}</span>
                </div>
              </td>
            </tr>
            <tr>
              <td>
                <div className="flex items-center gap-2">
                  <span>Ready to Withdraw </span>
                </div>
              </td>
              <td className="border-l-2 py-1 pl-2">
                <div className="flex items-center gap-2">
                  $<span>{formatCurrencyForDisplay(userCash?.ready ?? 0, Currency.USD)}</span>
                </div>
              </td>
            </tr>
            {userCash?.withdrawn > 0 && (
              <tr>
                <td>
                  <div className="flex items-center gap-2">
                    <span>Total Withdrawn </span>
                    <ActionIcon
                      onClick={() => {
                        dialogStore.trigger({
                          component: WithdrawalHistoryModal,
                        });
                      }}
                    >
                      <IconHistory size={14} />
                    </ActionIcon>
                  </div>
                </td>
                <td className="border-l-2 py-1 pl-2">
                  <div className="flex items-center gap-2">
                    $<span>{formatCurrencyForDisplay(userCash?.withdrawn ?? 0, Currency.USD)}</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {!canWithdraw && (
          <Alert color="red" className="mt-auto px-2">
            <div className="flex items-center gap-2">
              <IconLock size={24} className="shrink-0" />
              <div className="flex flex-1 flex-col">
                <p className="text-sm">
                  ${formatPriceForDisplay(MIN_WITHDRAWAL_AMOUNT)} is required to make a withdrawal
                </p>
              </div>
            </div>
          </Alert>
        )}

        {canWithdraw && !userPaymentConfiguration?.tipaltiPaymentsEnabled && (
          <Button leftIcon={<IconBuildingBank />} color="lime.7" onClick={handleSetupWithdrawals}>
            Setup Withdrawals
          </Button>
        )}

        {canWithdraw && userPaymentConfiguration?.tipaltiPaymentsEnabled && (
          <div className="flex flex-col gap-2">
            <div className="flex">
              <NumberInputWrapper
                label="Cash to Withdraw"
                labelProps={{ className: 'hidden' }}
                icon={<CurrencyIcon currency={Currency.USD} size={18} />}
                value={toWithdraw ? toWithdraw : undefined}
                min={MIN_WITHDRAWAL_AMOUNT}
                max={userCash?.ready ?? MIN_WITHDRAWAL_AMOUNT}
                onChange={(value) => {
                  setToWithdraw(value ?? MIN_WITHDRAWAL_AMOUNT);
                }}
                styles={{
                  input: {
                    borderTopRightRadius: 0,
                    borderBottomRightRadius: 0,
                    border: 0,
                  },
                }}
                step={1}
                currency={Currency.USD}
                format="currency"
              />
              <Tooltip label="Withdraw" position="top">
                <ActionIcon
                  miw={40}
                  variant="filled"
                  color="lime.7"
                  className="rounded-l-none"
                  h="100%"
                  loading={withdrawingCash}
                  disabled={
                    toWithdraw < MIN_WITHDRAWAL_AMOUNT || toWithdraw > (userCash?.ready ?? 0)
                  }
                  onClick={() => {
                    dialogStore.trigger({
                      component: ConfirmDialog,
                      props: {
                        title: 'Withdraw your cash',
                        message: (
                          <div className="flex flex-col gap-2">
                            <p>
                              You are about to withdraw ${formatCurrencyForDisplay(toWithdraw)} to
                              your bank.{' '}
                            </p>
                            <p> Are you sure?</p>
                          </div>
                        ),
                        labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
                        onConfirm: handleWithdrawal,
                      },
                    });
                  }}
                >
                  <IconBuildingBank size={24} />
                </ActionIcon>
              </Tooltip>
            </div>
            {userCash?.withdrawalFee && (
              <div className="flex flex-col gap-2">
                <p>
                  <span className="font-bold">Withdrawal fee:</span> $
                  {userCash?.withdrawalFee.type === 'fixed'
                    ? formatCurrencyForDisplay(userCash?.withdrawalFee.amount)
                    : formatCurrencyForDisplay(toWithdraw * userCash?.withdrawalFee.amount)}
                </p>
                <ActionIcon onClick={openWithdrawalFreeModal}>
                  <IconInfoCircle size={14} />
                </ActionIcon>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const WithdrawalHistoryModal = () => {
  const { withdrawalHistory, isLoading } = useWithdrawalHistory();
  const dialog = useDialogContext();

  return (
    <Modal {...dialog} title="Withdrawal History" size="lg" radius="md">
      <div className="flex flex-col gap-4">
        {isLoading && (
          <div className="flex items-center justify-center">
            <Loader />
          </div>
        )}

        {!isLoading && (
          <div>
            {(withdrawalHistory?.length ?? 0) === 0 ? (
              <p className="text-center opacity-50">You have no withdrawal history.</p>
            ) : (
              <Table className="table-auto">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {withdrawalHistory?.map((withdrawal) => (
                    <tr key={withdrawal.id}>
                      <td>{formatDate(withdrawal.createdAt, 'MMM D, YYYY @ hA [UTC]')}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <span>${numberWithCommas(withdrawal.amount)}</span>
                          {withdrawal.fee && (
                            <Tooltip label={`Withdrawal fee: $${withdrawal.fee}`} position="top">
                              <IconInfoCircle size={14} />
                            </Tooltip>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <span>{capitalize(withdrawal.status)}</span>
                          {withdrawal.note && (
                            <Tooltip label={withdrawal.note} position="top">
                              <IconInfoCircle size={14} />
                            </Tooltip>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};

const ExtractBuzzCard = () => {
  const { compensationPool, isLoading: isLoadingCompensationPool } = useCompensationPool();
  const { banked, isLoading: isLoadingBanked } = useBankedBuzz();
  const { extractBuzz, extractingBuzz } = useCreatorProgramMutate();

  const isLoading = isLoadingBanked || isLoadingCompensationPool;
  const extractionFee = getExtractionFee(banked?.total ?? 0);

  const [_, end] = compensationPool?.phases.extraction ?? [new Date(), new Date()];
  const shouldUseCountdown = new Date() > dayjs(end).subtract(2, 'day').toDate();
  const endDate = formatDate(end, 'MMM D, YYYY @ hA [UTC]');

  const handleExtractBuzz = async () => {
    try {
      await extractBuzz();
      showSuccessNotification({
        title: 'Success!',
        message: 'You have successfully extracted your Buzz.',
      });
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
        <h3 className="text-xl font-bold">Extract Buzz</h3>
        <p className="text-sm ">
          Not happy with your earnings? <br /> Extract Buzz to save it for next time!
        </p>

        <div className="mt-4 flex flex-col gap-2">
          <Tooltip label="Extract Buzz" position="top">
            <Button
              variant="light"
              color="yellow.7"
              styles={{ label: { width: '100%' } }}
              disabled={(banked?.total ?? 0) === 0}
              onClick={() => {
                dialogStore.trigger({
                  component: ConfirmDialog,
                  props: {
                    title: 'Extract your Buzz',
                    message: (
                      <div className="flex flex-col gap-2">
                        <p>
                          You are about to Extract{' '}
                          <CurrencyBadge unitAmount={banked?.total ?? 0} currency={Currency.BUZZ} />{' '}
                          from the Bank. This action is not reversible. You cannot Bank Buzz until
                          the next Banking Phase.
                        </p>
                        <p> Are you sure?</p>
                      </div>
                    ),
                    labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
                    onConfirm: handleExtractBuzz,
                  },
                });
              }}
            >
              <div className="flex w-full items-center  justify-between gap-2">
                <div className="flex gap-2">
                  <CurrencyIcon currency={Currency.BUZZ} size={18} />
                  <p className="text-sm">{numberWithCommas(banked?.total ?? 0)}</p>
                </div>

                <IconLogout />
              </div>
            </Button>
          </Tooltip>
          <div className="flex items-center gap-2">
            <p>
              <span className="font-bold">Extraction Fee:</span>{' '}
              <CurrencyIcon currency={Currency.BUZZ} size={14} className="inline" />
              {numberWithCommas(extractionFee)}
            </p>
            <ActionIcon
              onClick={() => {
                openExtractionFeeModal();
              }}
            >
              <IconInfoCircle size={14} />
            </ActionIcon>
          </div>
        </div>

        <Alert color="yellow" className="mt-auto px-2">
          <div className="flex items-center gap-2">
            <IconCalendar size={24} className="shrink-0" />
            <div className="flex flex-1 flex-col">
              <p className="text-nowrap font-bold">Extraction Phase Ends</p>
              <p className="text-nowrap text-xs">
                {shouldUseCountdown ? <Countdown endTime={end} /> : endDate}
              </p>
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
