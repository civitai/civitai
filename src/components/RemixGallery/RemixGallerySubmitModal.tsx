import { Alert, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useQueryImages } from '~/components/Image/image.utils';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Currency } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Submitting one of your own images into someone's remix gallery.
 *
 * The picker only offers your own published images because that is what the
 * mutation accepts; showing anything else would be an invitation to a refusal.
 */
export function RemixGallerySubmitModal({ hostImageId }: { hostImageId: number }) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<number | null>(null);

  const { data: visibility } = trpc.placement.getRemixGalleryVisibility.useQuery({
    imageId: hostImageId,
  });

  const { images, isLoading, fetchNextPage, hasNextPage, isRefetching } = useQueryImages(
    { userId: currentUser?.id, period: 'AllTime', limit: 50 },
    { enabled: !!currentUser }
  );

  const submit = trpc.placement.submitToRemixGallery.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Submitted',
        message: "Your remix is waiting for the creator's review.",
      });
      utils.placement.invalidate();
      dialog.onClose();
    },
    onError: (error) =>
      showErrorNotification({
        title: "Couldn't submit that",
        error: new Error(error.message),
      }),
  });

  const price = visibility?.price ?? null;

  return (
    <Modal {...dialog} title="Submit your remix" size="lg">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          The creator reviews every submission and decides what belongs in their gallery. If they
          decline yours, they keep part of what you paid and the rest is returned.
        </Text>

        {visibility && !visibility.open && (
          <Alert color="yellow" icon={<IconAlertTriangle />}>
            This creator has stopped accepting submissions.
          </Alert>
        )}

        {isLoading ? (
          <Group justify="center" py="xl">
            <Loader />
          </Group>
        ) : images.length ? (
          <div className="grid grid-cols-4 gap-3">
            {images.map((image) => (
              <AspectRatioImageCard
                key={image.id}
                aspectRatio="square"
                image={image}
                onClick={() => setSelected(image.id)}
                className={clsx('cursor-pointer', selected === image.id && 'ring-2 ring-blue-5')}
              />
            ))}
          </div>
        ) : (
          <NoContent message="You don't have any published images to submit yet." />
        )}

        {hasNextPage && (
          <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching}>
            <Group justify="center" py="md">
              <Loader size="sm" />
            </Group>
          </InViewLoader>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button
            disabled={!selected || !visibility?.open}
            loading={submit.isLoading}
            onClick={() => selected && submit.mutate({ hostImageId, imageId: selected })}
          >
            <Group gap={4} wrap="nowrap">
              <span>Submit</span>
              {price != null && (
                <>
                  <CurrencyIcon currency={Currency.BUZZ} size={14} />
                  <span>{price}</span>
                </>
              )}
            </Group>
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
