import { trpc } from '~/utils/trpc';
import { ModelFileType } from '~/server/common/constants';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { openPurchaseModelVersionModal } from '~/components/Modals/PurchaseModelVersionModal';
import { showSuccessNotification } from '~/utils/notifications';

export const useModelVersionPurchase = ({ modelVersionId }: { modelVersionId: number }) => {
  const { data: modelVersionWithPurchaseDetails, isLoading } =
    trpc.modelVersion.getPurchaseDetails.useQuery(
      { id: modelVersionId },
      { enabled: !!modelVersionId }
    );
  const queryUtils = trpc.useContext();

  const { canDownload, downloadRequiresPurchase } = modelVersionWithPurchaseDetails ?? {};

  const onDownloadFile = ({
    type,
    primary,
    meta,
  }: {
    type?: ModelFileType | string;
    primary?: boolean;
    meta?: FileMetadata;
  }) => {
    const downloadUrl = createModelFileDownloadUrl({
      versionId: modelVersionId,
      type,
      meta,
      primary,
    });

    if (!modelVersionWithPurchaseDetails || !downloadUrl || typeof window === 'undefined') {
      return;
    }

    if (!canDownload && downloadRequiresPurchase) {
      // User just needs to purchase the model
      openPurchaseModelVersionModal({
        modelVersionId,
        onSuccess: () => {
          queryUtils.modelVersion.getPurchaseDetails.invalidate({ id: modelVersionId });
          showSuccessNotification({
            message: 'Purchase successful! Your download will start right away!',
          });
          window.location.href = downloadUrl;
        },
      });
    } else if (canDownload) {
      // Allow download the file:
      window.location.href = downloadUrl;
    }

    return;
  };

  const price = !modelVersionWithPurchaseDetails
    ? null
    : {
        unitAmount: modelVersionWithPurchaseDetails?.monetization?.unitAmount,
        currency: modelVersionWithPurchaseDetails?.monetization?.currency,
      };

  return {
    price,
    isLoading,
    canDownload,
    onDownloadFile,
    downloadRequiresPurchase,
  };
};
