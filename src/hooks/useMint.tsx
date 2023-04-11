import { usePrepareContractWrite, useContractWrite, useWaitForTransaction } from 'wagmi';
import { BigNumber } from 'ethers';
import Factory from '~/contract/abi/Factory.json';
import { factoryContract } from '~/contract';

/**
 * Custom hook to mint ERC20 tokens
 * @param modelId - the ID of the model
 * @param modelName - the name of the model
 * @param modelSymbol - the symbol of the model
 * @param modelDecimals - the number of decimals for the model
 * @param modelInitialSupply - the initial supply of the model
 * @returns an object containing the prepareError, isPrepareError, data, error, isError, write, isLoading, and isSuccess
 */
export function useMintERC20Token(
  modelId: string,
  modelName: string,
  modelSymbol: string,
  modelDecimals: string,
  modelInitialSupply: string
) {
  const {
    config,
    error: prepareError,
    isError: isPrepareError,
  } = usePrepareContractWrite({
    address: factoryContract,
    abi: Factory.abi,
    functionName: 'deployNewERC20Token',
    args: [
      // BigNumber.from(modelId),
      modelName,
      modelSymbol,
      parseInt(modelDecimals) || 18,
      BigNumber.from(modelInitialSupply || 0),
    ],
    enabled:
      // Boolean(modelId) &&
      Boolean(modelName) &&
      Boolean(modelSymbol) &&
      Boolean(modelDecimals) &&
      Boolean(modelInitialSupply),
  });
  const { data, error, isError, write } = useContractWrite(config);

  const { isLoading, isSuccess } = useWaitForTransaction({
    hash: data?.hash,
  });

  return {
    prepareError,
    isPrepareError,
    data,
    error,
    isError,
    write,
    isLoading,
    isSuccess,
  };
}

/**
 * Custom hook to mint ERC721 tokens
 * @param modelId - the ID of the model
 * @param modelName - the name of the model
 * @param modelSymbol - the symbol of the model
 * @returns an object containing the prepareError, isPrepareError, data, error, isError, write, isLoading, and isSuccess
 */
export function useMintERC721Token(modelId: string, modelName: string, modelSymbol: string) {
  const {
    config,
    error: prepareError,
    isError: isPrepareError,
  } = usePrepareContractWrite({
    address: factoryContract,
    abi: Factory.abi,
    functionName: 'deployNewERC721Token',
    args: [
      // BigNumber.from(modelId),
      modelName,
      modelSymbol,
    ],
    enabled:
      // Boolean(modelId) &&
      Boolean(modelName) && Boolean(modelSymbol),
  });
  const { data, error, isError, write } = useContractWrite(config);

  const { isLoading, isSuccess } = useWaitForTransaction({
    hash: data?.hash,
  });

  return {
    prepareError,
    isPrepareError,
    data,
    error,
    isError,
    write,
    isLoading,
    isSuccess,
  };
}
