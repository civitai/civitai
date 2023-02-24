import { hideNotification, showNotification } from '@mantine/notifications';
import { cloneElement } from 'react';
import { useImageStore } from '~/store/images.store';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { ReportEntity } from '~/server/schema/report.schema';

const SEND_REPORT_ID = 'sending-report';

export const ReportImageNsfwButton = ({
  imageId,
  children,
}: {
  imageId: number;
  children:
    | React.ReactElement
    | ((args: { onClick: () => void; isLoading: boolean }) => React.ReactElement);
}) => {
  const setImage = useImageStore((state) => state.setImage);

  const { mutate, isLoading } = trpc.report.create.useMutation({
    onMutate() {
      showNotification({
        id: SEND_REPORT_ID,
        loading: true,
        disallowClose: true,
        autoClose: false,
        message: 'Sending report...',
      });
    },
    async onSuccess() {
      showSuccessNotification({
        title: 'Image reported',
        message: 'Your request has been received',
      });
      setImage({ id: imageId, nsfw: true });
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Unable to send report',
        reason: 'An unexpected error occurred, please try again',
      });
    },
    onSettled() {
      hideNotification(SEND_REPORT_ID);
    },
  });

  const onClick = () => {
    mutate({ type: ReportEntity.Image, id: imageId, reason: 'NSFW', details: {} });
  };

  return typeof children === 'function'
    ? children({ onClick, isLoading })
    : cloneElement(children, { onClick, loading: isLoading });
};
