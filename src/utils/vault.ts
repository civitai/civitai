import dayjs from 'dayjs';

export const getVaultState = (
  lastUpdatedAt: string | Date,
  storageKb: number,
  usedStorageKb: number
) => {
  const lastUpdated = dayjs(lastUpdatedAt);
  const downloadLimit = dayjs(lastUpdatedAt).add(7, 'day');
  const lastUpdatedIsLessThan7Days = lastUpdated.isAfter(downloadLimit);
  const lastUpdatedIsLessThan30Days = lastUpdated.isAfter(dayjs().subtract(30, 'day'));
  const isOutOfStorage = storageKb <= usedStorageKb;
  const canDownload =
    usedStorageKb > 0 && (storageKb > usedStorageKb || lastUpdatedIsLessThan7Days);

  return {
    lastUpdatedIsLessThan7Days,
    lastUpdatedIsLessThan30Days,
    isOutOfStorage,
    canDownload,
  };
};
