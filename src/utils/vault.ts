import dayjs from '~/shared/utils/dayjs';

export const getVaultState = (
  updatedAt: string | Date,
  storageKb: number,
  usedStorageKb: number
) => {
  // It is only possible to be above storage limit if the user has downgraded their account, as we do not
  // allow the user to upload more files than their current storage limit.
  const isBadState = usedStorageKb > storageKb;
  const downloadLimit = dayjs(updatedAt).add(30, 'day');
  const eraseLimit = dayjs(updatedAt).add(60, 'day');
  const isPastDownloadLimit = dayjs().isAfter(downloadLimit);
  const isOutOfStorage = storageKb <= usedStorageKb;
  const canDownload = usedStorageKb > 0 && (storageKb > usedStorageKb || !isPastDownloadLimit);

  return {
    isBadState,
    isPastDownloadLimit,
    isOutOfStorage,
    canDownload,
    downloadLimit,
    eraseLimit,
  };
};
