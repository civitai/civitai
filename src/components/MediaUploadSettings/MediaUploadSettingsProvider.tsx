import type { MediaType } from '~/shared/utils/prisma/enums';
import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';
import { constants } from '~/server/common/constants';

export type MediaUploadMaxSizeByType = { type: MediaType; maxSize: number }[];

export type MediaUploadSettings = {
  maxItems: number;
  maxSize?: number | MediaUploadMaxSizeByType;
  maxVideoDuration: number;
  maxVideoDimensions: number;
};

const defaultSettings: MediaUploadSettings = {
  maxItems: 20,
  maxSize: [
    { type: 'image', maxSize: constants.mediaUpload.maxImageFileSize },
    { type: 'video', maxSize: constants.mediaUpload.maxVideoFileSize },
  ],
  maxVideoDuration: constants.mediaUpload.maxVideoDurationSeconds,
  maxVideoDimensions: constants.mediaUpload.maxVideoDimension,
};

const MediaUploadSettingsContext = createContext<MediaUploadSettings>(defaultSettings);
export const useMediaUploadSettingsContext = () => {
  const context = useContext(MediaUploadSettingsContext);
  return context;
};

export const MediaUploadSettingsProvider = ({
  children,
  settings,
}: {
  children: ReactNode;
  settings?: Partial<MediaUploadSettings>;
}) => {
  return (
    <MediaUploadSettingsContext.Provider
      value={settings ? { ...defaultSettings, ...settings } : defaultSettings}
    >
      {children}
    </MediaUploadSettingsContext.Provider>
  );
};
