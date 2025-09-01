// ZKP2P utility functions - server infrastructure has been removed
// This file is kept for potential future use with the standalone ZKP2P UI

export const useMutateZkp2p = () => {
  // Server infrastructure removed - ZKP2P is handled by external service
  return {
    createBuzzOrderOnramp: () => Promise.reject(new Error('ZKP2P server infrastructure removed')),
    creatingBuzzOrderOnramp: false,
  };
};

export const useGetZkp2pTransactionStatus = (key?: string | null) => {
  // Server infrastructure removed - ZKP2P is handled by external service
  return {
    status: null,
    isLoading: false,
  };
};
