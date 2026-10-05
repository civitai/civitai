import { Alert, Group, Loader, Modal, Radio, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { PromotionCheckout } from '~/components/Promotion/PromotionCheckout';
import type { PromotionRunDays } from '~/shared/utils/promotion';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** Paying to show one of your own posts, marked Sponsored, in the gallery of a model it used. */
export function GalleryPromotionModal({ postId }: { postId: number }) {
  const dialog = useDialogContext();
  const utils = trpc.useUtils();
  const [modelId, setModelId] = useState<number | null>(null);
  const [days, setDays] = useState<PromotionRunDays>(1);

  const { data: hosts, isLoading, isError } = trpc.promotion.getHostsForPost.useQuery({ postId });
  const host = hosts?.find((candidate) => candidate.modelId === modelId) ?? null;

  const create = trpc.promotion.createGalleryPromotion.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Promotion sent',
        message: 'It is waiting for the page owner to review it.',
      });
      utils.promotion.invalidate();
      dialog.onClose();
    },
    onError: (error) =>
      showErrorNotification({
        title: "Couldn't promote this post",
        error: new Error(error.message),
      }),
  });

  return (
    <Modal
      {...dialog}
      title={
        <span className="flex flex-col gap-0.5">
          <span>Promote in a gallery</span>
          <Text span size="xs" fw={400} c="dimmed" className="block leading-snug">
            Show this post, marked Sponsored, in the gallery of a model you made it with.
          </Text>
        </span>
      }
      size="md"
      classNames={{ header: 'items-start' }}
    >
      <Stack gap="md">
        {isError ? (
          <Alert color="red" icon={<IconAlertTriangle />}>
            Couldn&apos;t load the models this post can be promoted on. Close this and try again.
          </Alert>
        ) : isLoading ? (
          <Group justify="center" py="md">
            <Loader />
          </Group>
        ) : !hosts?.length ? (
          <Text size="sm" c="dimmed">
            None of the models this post was made with are taking sponsored posts right now.
          </Text>
        ) : (
          <>
            <Radio.Group
              value={modelId != null ? String(modelId) : null}
              onChange={(value) => setModelId(Number(value))}
              label="Which model's gallery?"
            >
              <Stack gap="xs" mt="xs">
                {hosts.map((option) => (
                  <Radio
                    key={option.modelId}
                    value={String(option.modelId)}
                    label={
                      <span>
                        {option.name}{' '}
                        <Text span size="xs" c="dimmed">
                          {option.ownerUsername ? `by ${option.ownerUsername}, ` : ''}
                          {option.dailyPrice} Buzz a day
                        </Text>
                      </span>
                    }
                  />
                ))}
              </Stack>
            </Radio.Group>

            <PromotionCheckout
              quote={host}
              days={days}
              onDaysChange={setDays}
              loading={create.isPending}
              onBuy={(expected) =>
                host && create.mutate({ modelId: host.modelId, postId, days, ...expected })
              }
            />
          </>
        )}
      </Stack>
    </Modal>
  );
}
