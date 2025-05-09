import { Button } from '@mantine/core';
import Image from 'next/image';
import { useCallback, useMemo, useState } from 'react';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useJoinKnightsNewOrder } from '~/components/Games/KnightsNewOrder.utils';
import { NewOrderRulesModal } from '~/components/Games/NewOrder/NewOrderRulesModal';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';

export function NewOrderJoin() {
  const { join, isLoading } = useJoinKnightsNewOrder();
  const [opened, setOpened] = useState(false);

  const handleJoin = useCallback(() => {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: '⚠️ Sensitive Content Warning',
        message: (
          <>
            <p>
              This game contains explicit and sensitive content imagery, regardless of your on-site
              browsing level settings, that may not be suitable for all players.
            </p>
            <p>
              By continuing, you acknowledge that you are aware of the potential risks and agree to
              proceed at your own discretion.
            </p>
          </>
        ),
        labels: { cancel: 'Cancel', confirm: 'Agree and Continue' },
        onConfirm: async () => await join(),
      },
    });
  }, [join]);

  const joinButton = useMemo(
    () => (
      <LoginRedirect reason="knights-new-order">
        <Button
          className="bg-gold-9 text-white hover:bg-gold-7"
          onClick={handleJoin}
          loading={isLoading}
          fullWidth
        >
          Join Game
        </Button>
      </LoginRedirect>
    ),
    [handleJoin, isLoading]
  );

  return (
    <div
      className="-mt-3 flex size-full items-center justify-center p-4"
      style={{
        background: 'radial-gradient(circle, #133554 0%, #101113 50%, #101113 100%)',
      }}
    >
      <div className="mx-auto flex w-full max-w-[448px] flex-col items-center gap-4 text-center">
        <div className="relative max-w-xs overflow-hidden rounded-md">
          <Image
            className="size-full object-cover"
            alt="A knight in full plate armor and cape holding a sword wrapped in lighting animated"
            src="/images/games/new-order-animated-bg.webp"
            width={360}
            height={560}
          />
          <div className="absolute bottom-0 left-0 flex w-full flex-col gap-2 p-4">
            <Image
              className="size-full object-contain"
              alt="Title screen for knights of new order"
              src="/images/games/new-order-title.png"
              width={1024}
              height={430}
            />
            {joinButton}
            <Button
              className="text-gold-9"
              color="dark.9"
              onClick={() => setOpened(true)}
              fullWidth
            >
              Learn More
            </Button>
          </div>
        </div>
      </div>
      <NewOrderRulesModal opened={opened} onClose={() => setOpened(false)} footer={joinButton} />
    </div>
  );
}
