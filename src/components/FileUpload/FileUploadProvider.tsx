import React, { createContext, useContext, useEffect, useState } from 'react';

// #region [types]
type Status = 'pending' | 'error' | 'success' | 'uploading';
export type TrackedFile = {
  file: File;
  progress: number;
  uploaded: number;
  size: number;
  speed: number;
  timeRemaining: number;
  status: Status;
  abort: () => void;
  url: string;
};

type State = [files: TrackedFile[], setFiles: React.Dispatch<React.SetStateAction<TrackedFile[]>>];
// #endregion

// #region [context]
const Context = createContext<State | null>(null);
export function useFileUploadContext() {
  return useContext(Context);
}
// #endregion

export function FileUploadProvider({ children }: { children: React.ReactNode }) {
  const state = useState<TrackedFile[]>([]);
  const [files] = state;

  useEffect(() => {
    return () => {
      for (const file of files) {
        file.abort();
      }
    };
  }, []); // eslint-disable-line

  return <Context.Provider value={state}>{children}</Context.Provider>;
}
