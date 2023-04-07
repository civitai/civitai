import { Stack, Button, Paper, Text } from '@mantine/core';
import { useAccount } from 'wagmi';
import { z } from 'zod';
import { useWeb3ModalHelper } from '~/hooks/useWeb3ModalHelper';
import { useForm, Form, InputText } from '~/libs/form';
import { usePrepareContractWrite, useContractWrite, useWaitForTransaction } from 'wagmi';
import { IconGavel, IconWallet } from '@tabler/icons';
import { BigNumber } from 'ethers';
import Factory from '~/contract/abi/Factory.json';
import { chain, factoryContract } from '~/contract';

export const schema = z.object({
  name: z.string().min(1).max(32),
  symbol: z.string().min(1).max(32),
  decimals: z.string().regex(/^\d{1,18}$/),
  initialSupply: z.string().regex(/^\d{1,18}$/),
});

export function MintForm() {
  const { address, isConnected } = useAccount();
  const { connectWallet } = useWeb3ModalHelper();
  const form = useForm({
    schema,
    defaultValues: {
      name: '',
      symbol: '',
      decimals: '18',
      initialSupply: '10000000000',
    },
    mode: 'onBlur',
    shouldUnregister: false,
  });

  const modelName = form.watch('name');
  const modelSymbol = form.watch('symbol');
  const modelDecimals = form.watch('decimals');
  const modelInitialSupply = form.watch('initialSupply');

  const {
    config,
    error: prepareError,
    isError: isPrepareError,
  } = usePrepareContractWrite({
    address: factoryContract,
    abi: Factory.abi,
    functionName: 'deployNewERC20Token',
    args: [modelName, modelSymbol, parseInt(modelDecimals), BigNumber.from(modelInitialSupply)],
    enabled:
      Boolean(modelName) &&
      Boolean(modelSymbol) &&
      Boolean(modelDecimals) &&
      Boolean(modelInitialSupply),
  });
  const { data, error, isError, write } = useContractWrite(config);

  const { isLoading, isSuccess } = useWaitForTransaction({
    hash: data?.hash,
  });

  const onSubmit = async (data: z.infer<typeof schema>) => {
    console.log(data);
    // Connect wallet
    if (!isConnected) {
      return await connectWallet();
    }

    // call contract
    write?.();
  };

  return (
    <Paper shadow="xs" p="xs" withBorder>
      <Form form={form} onSubmit={onSubmit}>
        <Stack>
          <InputText name="name" label="Name" placeholder="eg: name" withAsterisk />
          <InputText name="symbol" label="Symbol" placeholder="eg: symbol" withAsterisk />
          <InputText
            name="decimals"
            label="Decimals"
            disabled
            clearable={false}
            value={18}
            withAsterisk
          />
          <InputText
            name="initialSupply"
            label="InitialSupply"
            placeholder="eg: 10000000000"
            withAsterisk
          />
          {address && (
            <Text color="dimmed" size="xs">
              Current Wallet: {address}
            </Text>
          )}
          {isConnected ? (
            <Button type="submit" disabled={!write || isLoading} leftIcon={<IconGavel size={16} />}>
              {isLoading ? 'Minting...' : 'Mint'}
            </Button>
          ) : (
            <Button onClick={() => connectWallet()} leftIcon={<IconWallet size={16} />}>
              Connect
            </Button>
          )}
          {isSuccess && (
            <Text color="green.8" size="xs">
              Successfully minted!
              <Text td="underline">
                <a
                  href={`${chain.blockExplorers?.etherscan.url}/tx/${data?.hash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Etherscan
                </a>
              </Text>
            </Text>
          )}

          {(isPrepareError || isError) && (
            <Text
              color="red.8"
              size="xs"
              style={{
                overflowWrap: 'break-word',
              }}
            >
              Error: {(prepareError || error)?.message || '-'}
            </Text>
          )}
        </Stack>
      </Form>
    </Paper>
  );
}
