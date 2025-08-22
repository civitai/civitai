import {
  Alert,
  Anchor,
  Badge,
  Button,
  Divider,
  Loader,
  Modal,
  Table,
  Text,
  Tooltip,
  NumberInput,
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
  IconSettings,
} from '@tabler/icons-react';
import clsx from 'clsx';
import dayjs from '~/shared/utils/dayjs';
import { capitalize } from 'lodash-es';
import type { HTMLProps } from 'react';
import React, { useEffect } from 'react';
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
  CreatorProgramCapsInfoModal,
  openCompensationPoolModal,
  openCreatorScoreModal,
  openEarningEstimateModal,
  openExtractionFeeModal,
  openPhasesModal,
  openSettlementModal,
  openWithdrawalFeeModal,
} from '~/components/Buzz/CreatorProgramV2/CreatorProgramV2.modals';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { Countdown } from '~/components/Countdown/Countdown';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink } from '~/components/NextLink/NextLink';
import { useRefreshSession } from '~/components/Stripe/memberships.util';
import { TosModal } from '~/components/ToSModal/TosModal';
import { useUserPaymentConfiguration } from '~/components/UserPaymentConfiguration/util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { OnboardingSteps } from '~/server/common/enums';
import {
  getCreatorProgramAvailability,
  getCurrentValue,
  getExtractionFee,
  getForecastedValue,
} from '~/server/utils/creator-program.utils';
import {
  MIN_WITHDRAWAL_AMOUNT,
  WITHDRAWAL_FEES,
} from '~/shared/constants/creator-program.constants';
import { Flags } from '~/shared/utils/flags';
import type { CashWithdrawalMethod } from '~/shared/utils/prisma/enums';
import { Currency } from '~/shared/utils/prisma/enums';
import { formatDate, roundMinutes } from '~/utils/date-helpers';
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

const DATE_FORMAT = 'MMM D, YYYY @ hA z';

// TODO creators program Can probably separate this file into multiple smaller ones. It's getting a bit long.
export const CreatorProgramV2 = () => {
  const currentUser = useCurrentUser();
  const { phase, isLoading } = useCreatorProgramPhase();
  const availability = getCreatorProgramAvailability(currentUser?.isModerator);
  useCreatorPoolListener();

  if (!currentUser || isLoading || !availability.isAvailable) {
    return null;
  }

  const hasOnboardedInProgram = Flags.hasFlag(
    currentUser.onboarding,
    OnboardingSteps.CreatorProgram
  );

  const isBanned = Flags.hasFlag(currentUser.onboarding, OnboardingSteps.BannedCreatorProgram);

  if (isBanned) {
    return null;
  }

  return (
    <div className="flex flex-col gap-5" id="creator-program">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-bold">Get Paid</h2>
          <CreatorProgramPhase />
        </div>
        <div className="flex gap-2">
          <p>Generating a lot of Buzz? Bank it to earn cash!</p>
          <Anchor href="/creator-program">Learn more</Anchor>
        </div>
      </div>

      {!hasOnboardedInProgram && (
        <div className="flex flex-col gap-4 md:flex-row">
          <JoinCreatorProgramCard />
          <CompensationPoolCard />
        </div>
      )}
      {hasOnboardedInProgram && (
        <div className="flex flex-col gap-4 md:flex-row">
          {phase === 'bank' && <BankBuzzCard />}
          {phase === 'extraction' && <ExtractBuzzCard />}
          <EstimatedEarningsCard />
          {<WithdrawCashCard />}
        </div>
      )}
    </div>
  );
};

const JoinCreatorProgramCard = () => {
  const buzzAccount = useBuzz(undefined, 'user');
  const { requirements, isLoading: isLoadingRequirements } = useCreatorProgramRequirements();
  // const { forecast, isLoading: isLoadingForecast } = useCreatorProgramForecast({
  //   buzz: buzzAccount.balance,
  // });
  const { compensationPool, isLoading: isLoadingCompensationPool } = useCompensationPool();
  const { joinCreatorsProgram, joiningCreatorsProgram } = useCreatorProgramMutate();
  const isLoading =
    buzzAccount.balanceLoading || isLoadingRequirements || isLoadingCompensationPool;
  const forecasted = compensationPool
    ? getForecastedValue(buzzAccount.balance, compensationPool)
    : undefined;

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
          <Text component="div">
            Your{' '}
            <CurrencyBadge
              currency={Currency.BUZZ}
              unitAmount={buzzAccount.balance}
              formatter={abbreviateNumber}
            />{' '}
            could be worth{' '}
            <span className="font-bold text-yellow-6">
              ${numberWithCommas(formatToLeastDecimals(forecasted ?? 0))}
            </span>
            !
          </Text>
          <LegacyActionIcon variant="subtle" color="gray" onClick={openEarningEstimateModal}>
            <IconInfoCircle size={14} />
          </LegacyActionIcon>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <p className="font-bold">Program requirements</p>
        <Divider />

        <div className="flex gap-4">
          <CreatorProgramRequirement
            isMet={hasEnoughCreatorScore}
            title={`Have a Creator Score higher than ${abbreviateNumber(
              requirements?.score.min ?? 10000
            )}`}
            content={
              <>
                <p className="my-0">
                  Your current{' '}
                  <Anchor
                    onClick={() => {
                      openCreatorScoreModal();
                    }}
                    inherit
                  >
                    Creator Score
                  </Anchor>{' '}
                  is {abbreviateNumber(requirements?.score.current ?? 0)}.
                </p>
              </>
            }
          />
          <CreatorProgramRequirement
            isMet={!!membership}
            title="Be a Civitai Member"
            content={
              hasValidMembership ? (
                <>
                  <p className="my-0">
                    You are a {capitalize(getDisplayName(membership as string))} Member! Thank you
                    for supporting Civitai.
                  </p>
                </>
              ) : membership ? (
                <>
                  <p className="my-0">
                    You are a {capitalize(getDisplayName(membership as string))} Member. Your
                    current membership does not apply to join the Creator Program. Consider
                    upgrading to one our supported memberships.
                    <br />
                    <Anchor component={NextLink} href="/pricing" inherit>
                      Upgrade Membership
                    </Anchor>
                  </p>
                </>
              ) : (
                <Anchor component={NextLink} href="/pricing">
                  Become a Civitai Member Now!
                </Anchor>
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

export const CreatorProgramRequirement = ({
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
        <IconCircleCheck className="shrink-0 text-green-500" size={25} />
      ) : (
        <IconCircleX className="shrink-0 text-red-500" size={25} />
      )}
      <div className="flex flex-col gap-0">
        <p className="my-0 font-bold">{title}</p>
        {typeof content === 'string' ? <p className="my-0">{content}</p> : content}
      </div>
    </div>
  );
};

export const CompensationPoolCard = () => {
  const { compensationPool, isLoading: isLoadingCompensationPool } = useCompensationPool();
  const isLoading = isLoadingCompensationPool;
  const date = formatDate(compensationPool?.phases.bank[0] ?? new Date(), 'MMMM YYYY', true);

  if (isLoading) {
    return (
      <div className={clsx(cardProps.className, 'h-full basis-1/4')}>
        <Loader className="m-auto" />
      </div>
    );
  }

  return (
    <div className={clsx(cardProps.className, 'h-full basis-1/4 gap-6')}>
      <div className="flex h-full flex-col justify-between gap-12">
        <div className="flex flex-col">
          <h3 className="my-0 text-center text-xl font-bold">Compensation Pool</h3>
          <p className="my-0 text-center">{date}</p>
        </div>

        <div className="flex flex-col">
          <p className="my-0 text-center text-2xl font-bold">
            ${numberWithCommas(formatToLeastDecimals(compensationPool?.value ?? 0))}
          </p>
        </div>
        <div className="flex flex-col">
          <h3 className="my-0 text-center text-xl font-bold">Current Banked Buzz</h3>
          <div className="flex justify-center gap-1">
            <CurrencyIcon className="my-auto" currency={Currency.BUZZ} size={20} />
            <span className="text-2xl font-bold">
              {numberWithCommas(compensationPool?.size.current)}
            </span>
          </div>
        </div>
        <Anchor onClick={openCompensationPoolModal}>
          <div className="flex items-center justify-center gap-2">
            <IconInfoCircle size={18} />
            <p className="text-sm leading-tight">How is this determined?</p>
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
  const [, end] = compensationPool?.phases.bank ?? [new Date(), new Date()];
  const endDate = formatDate(roundMinutes(end), DATE_FORMAT, false);
  const shouldUseCountdown = new Date() > dayjs.utc(end).subtract(2, 'day').toDate();

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
    ? Math.floor(Math.min(banked.cap.cap - banked.total, buzzAccount.balance))
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
            labelProps={{ className: '!hidden' }}
            leftSection={<CurrencyIcon currency={Currency.BUZZ} size={18} />}
            value={toBank ? toBank : undefined}
            min={10000}
            max={maxBankable}
            onChange={(value) => {
              setToBank(Math.min(Number(value ?? 10000), maxBankable));
            }}
            styles={{
              input: {
                borderTopRightRadius: 0,
                borderBottomRightRadius: 0,
                border: 0,
              },
            }}
            step={1000}
            allowDecimal={false}
          />
          <Tooltip label="Bank now!" position="top">
            <LegacyActionIcon
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
            </LegacyActionIcon>
          </Tooltip>
        </div>
        <Button
          size="compact-xs"
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
          <LegacyActionIcon color="gray" variant="subtle" onClick={openEarningEstimateModal}>
            <IconInfoCircle size={14} />
          </LegacyActionIcon>
        </div>

        <Alert color="yellow" className="mt-auto p-2">
          <div className="flex items-center gap-2">
            <IconCalendar size={24} className="shrink-0" />
            <div className="flex flex-1 flex-col">
              <p className="text-nowrap font-bold">Banking Phase Ends</p>
              <p className="text-nowrap text-xs">
                {shouldUseCountdown ? <Countdown endTime={end} /> : endDate}
              </p>
            </div>
            <LegacyActionIcon onClick={openPhasesModal}>
              <IconInfoCircle size={18} />
            </LegacyActionIcon>
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
  const cap = banked?.cap?.cap;
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

        <Table className="-mt-2 table-auto">
          <Table.Tbody>
            <Table.Tr className="font-bold">
              <Table.Td colSpan={2} className="border-b">
                <div className="flex items-center gap-1">
                  <span>Compensation Pool</span>
                  <LegacyActionIcon onClick={openCompensationPoolModal}>
                    <IconInfoCircle size={18} />
                  </LegacyActionIcon>
                </div>
              </Table.Td>
              <Table.Td className="border-b border-l py-1 pl-2">
                ${numberWithCommas(formatToLeastDecimals(compensationPool?.value ?? 0))}
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td colSpan={2} className="border-b">
                Total Banked Buzz
              </Table.Td>
              <Table.Td className="border-b border-l py-1 pl-2">
                <div className="flex items-center gap-2">
                  <CurrencyIcon currency={Currency.BUZZ} size={16} />
                  <span>{numberWithCommas(compensationPool?.size.current)}</span>
                </div>
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>Your Banked Buzz</Table.Td>
              <Table.Td className="text-right">
                {cap && (
                  <Text
                    c="blue.4"
                    className="cursor-pointer pr-2 text-sm"
                    td="underline"
                    onClick={() => {
                      dialogStore.trigger({
                        component: CreatorProgramCapsInfoModal,
                      });
                    }}
                  >
                    {abbreviateNumber(cap)} Cap
                  </Text>
                )}
              </Table.Td>
              <Table.Td className="border-l py-1 pl-2">
                <div className="flex items-center gap-2">
                  <CurrencyIcon currency={Currency.BUZZ} size={16} />
                  <span>{numberWithCommas(banked.total)}</span>
                  {isCapped && (
                    <Badge color="yellow" size="sm">
                      Capped
                    </Badge>
                  )}
                </div>{' '}
              </Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>

        <div className="mb-4 flex flex-col gap-0">
          <div className="flex items-center gap-1">
            <p className="text-lg">
              <span className="font-bold">Your Current Value:</span> $
              {compensationPool
                ? numberWithCommas(
                    formatToLeastDecimals(getCurrentValue(banked.total ?? 0, compensationPool))
                  )
                : 'N/A'}
            </p>
            <LegacyActionIcon onClick={openEarningEstimateModal}>
              <IconInfoCircle size={18} />
            </LegacyActionIcon>
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
              <Anchor onClick={openPhasesModal} inherit>
                Extraction Phase
              </Anchor>
              :
            </p>
            <p className="text-sm">
              {formatDate(roundMinutes(compensationPool.phases.extraction[0]), DATE_FORMAT, false)}{' '}
              &ndash;{' '}
              {formatDate(roundMinutes(compensationPool.phases.extraction[1]), DATE_FORMAT, false)}
            </p>
          </div>
        )}
        {phase === 'extraction' && (
          <div className="flex flex-col gap-0">
            <p className="text-sm font-bold"> Not happy with your estimated earnings?</p>
            <p className="text-sm">
              You can extract your Buzz until{' '}
              {formatDate(roundMinutes(compensationPool.phases.extraction[1]), DATE_FORMAT, false)}
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

const WithdrawCashCard = () => {
  const { userCash, isLoading: isLoadingCash } = useUserCash();
  const { withdrawCash, withdrawingCash } = useCreatorProgramMutate();
  const { userPaymentConfiguration, isLoading: isLoadingPaymentConfiguration } =
    useUserPaymentConfiguration();

  const [toWithdraw, setToWithdraw] = React.useState<number>(MIN_WITHDRAWAL_AMOUNT / 100);

  const isLoading = isLoadingCash || isLoadingPaymentConfiguration;
  const withdrawalMethodSetup = userPaymentConfiguration?.tipaltiWithdrawalMethod;
  const unsupportedWithdrawalMethod = withdrawalMethodSetup
    ? !WITHDRAWAL_FEES[userPaymentConfiguration.tipaltiWithdrawalMethod as CashWithdrawalMethod]
    : false;
  const supportedWithdrawalMethods = Object.keys(WITHDRAWAL_FEES).filter(
    (k) => !!WITHDRAWAL_FEES[k as keyof typeof WITHDRAWAL_FEES]
  );

  useEffect(() => {
    if (userCash && userCash.ready) {
      setToWithdraw(Math.max(userCash.ready, MIN_WITHDRAWAL_AMOUNT) / 100);
    }
  }, [userCash]);

  const handleWithdrawal = async () => {
    try {
      await withdrawCash({ amount: Math.round(toWithdraw * 100) });
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
    (userCash?.ready ?? 0) >= MIN_WITHDRAWAL_AMOUNT || (userCash?.withdrawn ?? 0) > 0;

  return (
    <div className={clsx(cardProps.className, 'basis-1/4 gap-6')}>
      <div className="flex h-full flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xl font-bold">Withdraw Cash</h3>
          {userPaymentConfiguration?.tipaltiPaymentsEnabled && (
            <Anchor href="/tipalti/setup">
              <IconSettings size={18} color="white" />
            </Anchor>
          )}
        </div>
        <p className="text-sm">Once you&rsquo;ve earned cash, you can withdraw it to your bank</p>
        <Table className="mb-4 table-auto">
          <Table.Tbody>
            <Table.Tr className="border-b">
              <Table.Td>
                <div className="flex items-center gap-1">
                  <span>Pending Settlement </span>
                  <LegacyActionIcon onClick={openSettlementModal}>
                    <IconInfoCircle size={14} />
                  </LegacyActionIcon>
                </div>
              </Table.Td>
              <Table.Td className="border-l py-1 pl-2">
                <div className="flex items-center gap-2">
                  $<span>{formatCurrencyForDisplay(userCash?.pending ?? 0, Currency.USD)}</span>
                </div>
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                <div className="flex items-center gap-2">
                  <span>Ready to Withdraw </span>
                </div>
              </Table.Td>
              <Table.Td className="border-l py-1 pl-2">
                <div className="flex items-center gap-2">
                  $<span>{formatCurrencyForDisplay(userCash?.ready ?? 0, Currency.USD)}</span>
                </div>
              </Table.Td>
            </Table.Tr>
            {userCash?.withdrawn > 0 && (
              <Table.Tr className="border-t">
                <Table.Td>
                  <div className="flex items-center gap-2">
                    <span>Total Withdrawn </span>
                    <LegacyActionIcon
                      onClick={() => {
                        dialogStore.trigger({
                          component: WithdrawalHistoryModal,
                        });
                      }}
                    >
                      <IconHistory size={14} />
                    </LegacyActionIcon>
                  </div>
                </Table.Td>
                <Table.Td className="border-l py-1 pl-2">
                  <div className="flex items-center gap-2">
                    $<span>{formatCurrencyForDisplay(userCash?.withdrawn ?? 0, Currency.USD)}</span>
                  </div>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>

        {!canWithdraw && (
          <Alert color="red" className="mt-auto p-2">
            <div className="flex items-center gap-2">
              <IconLock size={24} className="shrink-0" />
              <div className="flex flex-1 flex-col">
                <p className="text-sm leading-tight">
                  ${formatPriceForDisplay(MIN_WITHDRAWAL_AMOUNT, 'USD', { decimals: false })} is
                  required to make a withdrawal
                </p>
              </div>
            </div>
          </Alert>
        )}

        {canWithdraw && !userPaymentConfiguration?.tipaltiPaymentsEnabled && (
          <Button
            leftSection={<IconBuildingBank />}
            color="lime.7"
            onClick={handleSetupWithdrawals}
          >
            Setup Withdrawals
          </Button>
        )}

        {canWithdraw && userPaymentConfiguration?.tipaltiPaymentsEnabled && (
          <div className="flex flex-col gap-2">
            <div className="flex">
              <NumberInput
                label="Cash to Withdraw"
                labelProps={{ className: '!hidden' }}
                leftSection={<CurrencyIcon currency={Currency.USD} size={18} />}
                value={toWithdraw}
                min={MIN_WITHDRAWAL_AMOUNT / 100}
                max={(userCash?.ready ?? MIN_WITHDRAWAL_AMOUNT) / 100}
                decimalScale={2}
                fixedDecimalScale
                thousandSeparator=","
                onChange={(value: number | string) => {
                  setToWithdraw(Number(value ?? MIN_WITHDRAWAL_AMOUNT));
                }}
                styles={{
                  input: {
                    borderTopRightRadius: 0,
                    borderBottomRightRadius: 0,
                    border: 0,
                  },
                }}
                step={10}
              />
              <Tooltip label="Withdraw" position="top">
                <LegacyActionIcon
                  miw={40}
                  variant="filled"
                  color="lime.7"
                  className="rounded-l-none"
                  h="100%"
                  loading={withdrawingCash}
                  disabled={
                    toWithdraw < MIN_WITHDRAWAL_AMOUNT / 100 ||
                    toWithdraw > (userCash?.ready ?? 0) / 100 ||
                    unsupportedWithdrawalMethod ||
                    !withdrawalMethodSetup
                  }
                  onClick={() => {
                    dialogStore.trigger({
                      component: ConfirmDialog,
                      props: {
                        title: 'Withdraw your cash',
                        message: (
                          <div className="flex flex-col gap-2">
                            <p>
                              You are about to request a withdrawal of $
                              {formatCurrencyForDisplay(Math.round(toWithdraw * 100))}{' '}
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
                </LegacyActionIcon>
              </Tooltip>
            </div>
            {!withdrawalMethodSetup && (
              <Alert color="red" className="mt-auto p-2">
                <p>
                  It does not seem your withdrawal method has been setup. Please go into your
                  withdrawal method settings to configure.
                </p>
              </Alert>
            )}
            {unsupportedWithdrawalMethod && (
              <Alert color="red" className="mt-auto p-2">
                <p>
                  Your currently selected withdrawal method is not supported. Please{' '}
                  <Anchor href="/tipalti/setup" inherit>
                    update your withdrawal method
                  </Anchor>{' '}
                  to one of our supported methods: {supportedWithdrawalMethods.join(', ')}.
                </p>
              </Alert>
            )}
            {userCash?.withdrawalFee && (
              <div className="flex gap-2">
                <p>
                  <span className="font-bold">Withdrawal fee:</span> $
                  {userCash?.withdrawalFee.type === 'fixed'
                    ? formatCurrencyForDisplay(userCash?.withdrawalFee.amount)
                    : formatCurrencyForDisplay(toWithdraw * userCash?.withdrawalFee.amount)}
                </p>
                <LegacyActionIcon onClick={openWithdrawalFeeModal}>
                  <IconInfoCircle size={14} />
                </LegacyActionIcon>
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
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Date</Table.Th>
                    <Table.Th>Amount</Table.Th>
                    <Table.Th>Status</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {withdrawalHistory?.map((withdrawal) => (
                    <Table.Tr key={withdrawal.id}>
                      <Table.Td>{formatDate(withdrawal.createdAt, 'MMM D, YYYY @ hA z')}</Table.Td>
                      <Table.Td>
                        <div className="flex items-center gap-2">
                          <span>${formatCurrencyForDisplay(withdrawal.amount)}</span>
                          {withdrawal.fee && (
                            <Tooltip
                              label={`Withdrawal fee: $${formatCurrencyForDisplay(withdrawal.fee)}`}
                              position="top"
                            >
                              <IconInfoCircle size={14} />
                            </Tooltip>
                          )}
                        </div>
                      </Table.Td>
                      <Table.Td>
                        <div className="flex items-center gap-2">
                          <span>{getDisplayName(withdrawal.status)}</span>
                          {withdrawal.note && (
                            <Tooltip label={withdrawal.note} position="top">
                              <IconInfoCircle size={14} />
                            </Tooltip>
                          )}
                        </div>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
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
  const shouldUseCountdown = new Date() > dayjs.utc(end).subtract(2, 'day').toDate();
  const endDate = formatDate(roundMinutes(end), DATE_FORMAT, false);

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
                          from the Bank.
                        </p>
                        <p>
                          This action is not reversible. You cannot Bank Buzz until the next Banking
                          Phase.
                        </p>
                        <Alert color="yellow">
                          <p>
                            If you are intending to withdraw cash,{' '}
                            <span className="font-bold">DO NOT EXTRACT</span>. Buzz must remain in
                            the Bank to be eligible for payout.
                          </p>
                        </Alert>
                        <p> Are you sure you want to proceed with Extraction??</p>
                      </div>
                    ),
                    labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
                    onConfirm: handleExtractBuzz,
                    confirmProps: {
                      color: 'red',
                    },
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
            <LegacyActionIcon
              onClick={() => {
                openExtractionFeeModal();
              }}
            >
              <IconInfoCircle size={14} />
            </LegacyActionIcon>
          </div>
        </div>

        <Alert color="yellow" className="mt-auto p-2">
          <div className="flex items-center gap-2">
            <IconCalendar size={24} className="shrink-0" />
            <div className="flex flex-1 flex-col">
              <p className="text-nowrap font-bold">Extraction Phase Ends</p>
              <p className="text-nowrap text-xs">
                {shouldUseCountdown ? <Countdown endTime={end} /> : endDate}
              </p>
            </div>
            <LegacyActionIcon onClick={openPhasesModal}>
              <IconInfoCircle size={18} />
            </LegacyActionIcon>
          </div>
        </Alert>
      </div>
    </div>
  );
};
