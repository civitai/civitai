import { Anchor, Button, Divider, Loader } from '@mantine/core';
import { IconCircleCheck, IconCircleX, IconUxCircle } from '@tabler/icons-react';
import { capitalize } from 'lodash-es';
import React from 'react';
import { useCreatorProgramForecast, useCreatorProgramRequirements } from '~/components/Buzz/CreatorProgramV2/CreatorProgram.util';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import AlertDialog from '~/components/Dialog/Common/AlertDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { NextLink } from '~/components/NextLink/NextLink';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { OnboardingSteps } from '~/server/common/enums';
import { Flags } from '~/shared/utils';
import { Currency } from '~/shared/utils/prisma/enums';
import { abbreviateNumber,  formatToLeastDecimals, numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';

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
        <p>
          Generating a lot of Buzz? Bank it to earn cash! <a href="/buzz">Learn more</a>.
        </p>
      </div>

      {!hasOnboardedInProgram && <JoinCreatorProgramCard />}
    </div>
  );
};

const JoinCreatorProgramCard = () => {
  const buzzAccount = useBuzz(undefined, 'user');
  const { requirements, isLoading: isLoadingRequirements } = useCreatorProgramRequirements();
  const {
    forecast,
    isLoading: isLoadingForecast,
  } = useCreatorProgramForecast({
    buzz: buzzAccount.balance,
  });
  const isLoading = buzzAccount.balanceLoading || isLoadingRequirements || isLoadingForecast;

  const membership = requirements?.membership;
  const hasEnoughCreatorScore = requirements?.score.current >= requirements?.score.min;

  if (isLoading) {
    return (
      <div className="light:bg-gray-0 flex flex-col gap-2 rounded-lg p-4 dark:bg-dark-5 align-center">
        <Loader />
      </div>
    );
  }

 
  return (
    <div className="light:bg-gray-0 flex flex-col gap-6 rounded-lg p-4 dark:bg-dark-5">
      <div className="flex flex-col gap-2">
        <h3 className="text-xl font-bold">Join the Creators Program</h3>
        <p>
          Your{' '}
          <CurrencyBadge
            currency={Currency.BUZZ}
            unitAmount={buzzAccount.balance}
            formatter={abbreviateNumber}
          />{' '}
          could be worth <span className="font-bold text-yellow-6">${numberWithCommas(formatToLeastDecimals(forecast.forecastedEarning))}</span>!{' '}
        </p>
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
                Your current <Anchor  onClick={() => { 
                  dialogStore.trigger({
                    component: AlertDialog,
                    props: {
                      title: 'What is your Creator Score?',
                      type: 'info',
                      children: ({ handleClose }) => (
                        <div className='flex flex-col gap-4 align-center'>
                        <p className="text-center">
                          Creator Score is a value that we compute behind the scenes based on your activity within the Civitai community and engagement with content and models that you've created.
                        </p>
                        <Button onClick={handleClose}>Close</Button>
                        </div>
                      ), 
                    }
                  })
                }}>Creator Score</Anchor> is{' '}
                {abbreviateNumber(requirements?.score.current ?? 0)}.
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
          console.log('Join the Creators Program');
        }}
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
