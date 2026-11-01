import { Alert, Group, Loader, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { PromotionCheckout } from '~/components/Promotion/PromotionCheckout';
import type { PromotionRunDays } from '~/shared/utils/promotion';
import { parseHostModelId } from '~/shared/utils/promotion';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** Paying to show one of your own models, marked Sponsored, in another model page's Suggested Resources. */
export function ModelPromotionModal({ modelId }: { modelId: number }) {
  const dialog = useDialogContext();
  const utils = trpc.useUtils();
  const [input, setInput] = useState('');
  const [days, setDays] = useState<PromotionRunDays>(1);
  const [debounced] = useDebouncedValue(input, 400);
  const hostId = parseHostModelId(debounced);

  const {
    data: offer,
    isFetching,
    isError,
  } = trpc.promotion.getModelOffer.useQuery(
    { modelId: hostId ?? 0 },
    { enabled: hostId != null && hostId !== modelId }
  );

  const create = trpc.promotion.createModelPromotion.useMutation({
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
        title: "Couldn't promote this model",
        error: new Error(error.message),
      }),
  });

  const quote = offer?.open ? offer : null;
  const refusal =
    hostId === modelId
      ? 'A model cannot be promoted on its own page.'
      : offer && !offer.open
      ? offer.reason
      : null;

  return (
    <Modal
      {...dialog}
      title={
        <span className="flex flex-col gap-0.5">
          <span>Promote this model</span>
          <Text span size="xs" fw={400} c="dimmed" className="block leading-snug">
            Show this model, marked Sponsored, in another model page&apos;s Suggested Resources.
          </Text>
        </span>
      }
      size="md"
      classNames={{ header: 'items-start' }}
    >
      <Stack gap="md">
        <TextInput
          label="Which model page?"
          description="Paste a link to the model page, or its id."
          placeholder="https://civitai.com/models/..."
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          error={debounced.trim() && hostId == null ? 'That is not a model link or id.' : undefined}
          rightSection={isFetching ? <Loader size="xs" /> : null}
        />

        {isError ? (
          <Alert color="red" icon={<IconAlertTriangle />}>
            Couldn&apos;t check that model page. Try again.
          </Alert>
        ) : refusal ? (
          <Text size="sm" c="yellow">
            {refusal}
          </Text>
        ) : (
          quote && (
            <Group gap={4}>
              <Text size="sm">
                {quote.name}
                {quote.ownerUsername ? ` by ${quote.ownerUsername}` : ''}
              </Text>
            </Group>
          )
        )}

        <PromotionCheckout
          quote={quote}
          days={days}
          onDaysChange={setDays}
          loading={create.isPending}
          onBuy={(expected) =>
            quote &&
            create.mutate({
              modelId: quote.modelId,
              promotedModelId: modelId,
              days,
              ...expected,
            })
          }
        />
      </Stack>
    </Modal>
  );
}
