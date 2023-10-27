import { ImageIngestionStatus } from '@prisma/client';
import React, { createContext, useContext, useEffect, useRef } from 'react';
import { createStore, useStore } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { VotableTagModel } from '~/libs/tags';
import { GetIngestionResultsProps } from '~/server/services/image.service';
import { QS } from '~/utils/qs';

type PendingIngestion = Record<number, { attempts: number; success: boolean }>;

type StoreState = {
  images: GetIngestionResultsProps;
  setImages: (data: GetIngestionResultsProps) => void;
  pending: PendingIngestion;
  setPending: (data: PendingIngestion) => void;
};

const createIngestionStore = () =>
  createStore<StoreState>()(
    devtools(
      immer((set, get) => ({
        images: {},
        pending: {},
        setImages: (data) => {
          set((state) => {
            for (const key in data) {
              if (data.hasOwnProperty(key)) {
                if (!state.images[key] || state.images[key].ingestion !== data[key].ingestion) {
                  state.images[key] = data[key];
                }
              }
            }
          });
        },
        setPending: (data) => {
          set((state) => {
            for (const key in data) {
              if (data.hasOwnProperty(key)) {
                state.pending[key] = data[key];
              }
            }
          });
        },
      }))
    )
  );

type ImageIngestionState = ReturnType<typeof createIngestionStore>;

const MAX_ATTEMPTS = 5;
const TIMEOUT_BASE = 1000;
const ImageIngestionContext = createContext<ImageIngestionState | null>(null);
export const ImageIngestionProvider = ({
  ids,
  children,
}: {
  ids: number[];
  children: React.ReactNode;
}) => {
  const idsRef = useRef(ids);
  const fetchingRef = useRef(false);
  // const timeoutRef = useRef<NodeJS.Timeout | undefined>();
  const pendingRef = useRef<PendingIngestion>({});
  const storeRef = useRef<ImageIngestionState>();
  if (!storeRef.current) {
    storeRef.current = createIngestionStore();
  }

  useEffect(() => {
    idsRef.current = ids;
    if (!ids.length || !!fetchingRef.current) return;
    getIngestionResults();
  }, [ids]); // eslint-disable-line

  const getIngestionResults = async () => {
    fetchingRef.current = true;
    const ids = idsRef.current;

    const currentPendingIds = Object.keys(pendingRef.current).map(Number);
    const bumpAmount = ids.some((id) => !currentPendingIds.includes(id)) ? 0 : 1;

    const pendingIds: number[] = [];
    for (const id of ids) {
      if (!pendingRef.current[id]) pendingRef.current[id] = { attempts: 0, success: false };
      pendingRef.current[id] = {
        ...pendingRef.current[id],
        attempts: pendingRef.current[id].attempts + bumpAmount,
      };
      if (pendingRef.current[id].attempts < MAX_ATTEMPTS && !pendingRef.current[id].success)
        pendingIds.push(id);
    }

    if (!pendingIds.length) {
      fetchingRef.current = false;
      return;
    }
    const response = await fetch(`/api/image/ingestion-results?ids=${pendingIds.join(',')}`);
    if (!response.ok) {
      fetchingRef.current = false;
      return;
    }
    const data: GetIngestionResultsProps = await response.json();

    // set non-pending
    for (const key in data) {
      if (pendingRef.current.hasOwnProperty(key)) {
        pendingRef.current[key] = {
          ...pendingRef.current[key],
          success: data[key].ingestion !== ImageIngestionStatus.Pending,
        };
      }
      // Fix date mapping
      if (!!data[key].tags) {
        for (const tag of data[key].tags as VotableTagModel[]) {
          if (!tag.lastUpvote) continue;
          tag.lastUpvote = new Date(tag.lastUpvote);
        }
      }
    }

    // set provider state
    storeRef.current?.getState().setImages(data);
    storeRef.current?.getState().setPending(pendingRef.current);

    const attempts = Object.values(pendingRef.current).map((x) => x.attempts);
    const shouldRetry =
      Object.values(pendingRef.current)
        .map((x) => x.success)
        .filter((x) => !x).length > 0;
    const minAttempts = Math.min(...attempts);

    let hasNewIds = false;
    for (const id of ids) {
      if (!pendingRef.current[id]) hasNewIds = true;
    }

    if (hasNewIds || shouldRetry) {
      setTimeout(getIngestionResults, hasNewIds ? TIMEOUT_BASE : TIMEOUT_BASE * minAttempts);
    } else {
      fetchingRef.current = false;
    }
  };

  return (
    <ImageIngestionContext.Provider value={storeRef.current}>
      {children}
    </ImageIngestionContext.Provider>
  );
};

export function useImageIngestionContext<T>(selector: (state: StoreState) => T) {
  const store = useContext(ImageIngestionContext);
  if (!store) throw new Error('Missing ImageIngestionContext.Provider in the tree');
  return useStore(store, selector);
}
