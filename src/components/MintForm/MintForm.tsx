import { Stack, Button, Paper, Text } from '@mantine/core';
import { useAccount } from 'wagmi';
import { z } from 'zod';
import { useWeb3ModalHelper } from '~/hooks/useWeb3ModalHelper';
import { useForm, Form, InputText, InputSelect } from '~/libs/form';
import { IconGavel, IconWallet } from '@tabler/icons';
import { chain } from '~/contract';
import { useRouter } from 'next/router';
import { TokenStandard, type TokensProps } from '~/types/mint';
import { useMintERC20Token, useMintERC721Token } from '~/hooks/useMint';
import { useMemo } from 'react';

const schema = z.object({
  tokenStandard: z.nativeEnum(TokenStandard),
  name: z.string().min(1).max(32),
  symbol: z.string().min(1).max(32),
  decimals: z.string().regex(/^\d{1,18}$/),
  initialSupply: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional()
    .default('0'),
});

type RenderErrorTextProps = {
  isModelERC20: boolean; // whether the token standard is ERC20
  isModelERC721: boolean; // whether the token standard is ERC721
  isPrepareErrorERC20: boolean; // whether there is a prepare error for ERC20
  isPrepareErrorERC721: boolean; // whether there is a prepare error for ERC721
  isErrorERC20: boolean; // whether there is an error for ERC20
  isErrorERC721: boolean; // whether there is an error for ERC721
  prepareErrorERC20: Error | null; // the prepare error for ERC20
  prepareErrorERC721: Error | null; // the prepare error for ERC721
  errorERC20: Error | null; // the error for ERC20
  errorERC721: Error | null; // the error for ERC721
};

/**
 * Renders error text based on the current state of the form and token standard.
 * @param {RenderErrorTextProps} props - The props object.
 * @returns {JSX.Element} - The error text element.
 */
const renderErrorText = ({
  isModelERC20,
  isModelERC721,
  isPrepareErrorERC20,
  isPrepareErrorERC721,
  isErrorERC20,
  isErrorERC721,
  prepareErrorERC20,
  prepareErrorERC721,
  errorERC20,
  errorERC721,
}: RenderErrorTextProps): JSX.Element | undefined => {
  if (
    (isModelERC20 && (isPrepareErrorERC20 || isErrorERC20)) ||
    (isModelERC721 && (isPrepareErrorERC721 || isErrorERC721))
  ) {
    return (
      <Text
        color="red.8"
        size="xs"
        style={{
          overflowWrap: 'break-word',
        }}
      >
        Error:{' '}
        {(isModelERC20 && (prepareErrorERC20?.message || errorERC20?.message)) ||
          (isModelERC721 && (prepareErrorERC721?.message || errorERC721?.message)) ||
          '-'}
      </Text>
    );
  }
};

type Props = {
  tokens: TokensProps;
};

export function MintForm({ tokens }: Props) {
  const router = useRouter();
  const modelId = router.query.id as string;

  const defaultTokenStandardSelectValue = useMemo(() => {
    if (!tokens?.erc20) {
      return TokenStandard.ERC20;
    }
    if (!tokens?.erc721) {
      return TokenStandard.ERC721;
    }
    return undefined;
  }, [tokens?.erc20, tokens?.erc721]);

  const { address, isConnected } = useAccount();
  const { connectWallet } = useWeb3ModalHelper();
  const form = useForm({
    schema,
    defaultValues: {
      tokenStandard: defaultTokenStandardSelectValue,
      name: '',
      symbol: '',
      decimals: '18',
      initialSupply: '10000000000',
    },
    mode: 'onBlur',
    shouldUnregister: false,
  });

  const modelTokenStandard = form.watch('tokenStandard');
  const modelName = form.watch('name');
  const modelSymbol = form.watch('symbol');
  const modelDecimals = form.watch('decimals');
  const modelInitialSupply = form.watch('initialSupply');

  const {
    prepareError: prepareErrorERC20,
    isPrepareError: isPrepareErrorERC20,
    data: dataERC20,
    error: errorERC20,
    isError: isErrorERC20,
    write: writeERC20,
    isLoading: isLoadingERC20,
    isSuccess: isSuccessERC20,
  } = useMintERC20Token(modelId, modelName, modelSymbol, modelDecimals, modelInitialSupply);

  const {
    prepareError: prepareErrorERC721,
    isPrepareError: isPrepareErrorERC721,
    data: dataERC721,
    error: errorERC721,
    isError: isErrorERC721,
    write: writeERC721,
    isLoading: isLoadingERC721,
    isSuccess: isSuccessERC721,
  } = useMintERC721Token(modelId, modelName, modelSymbol);

  const isModelERC20 = useMemo(
    () => modelTokenStandard === TokenStandard.ERC20,
    [modelTokenStandard]
  );
  const isModelERC721 = useMemo(
    () => modelTokenStandard === TokenStandard.ERC721,
    [modelTokenStandard]
  );

  const validTokenStandardSelectData = useMemo(() => {
    const data = [];
    if (!tokens?.erc20) {
      data.push({ value: TokenStandard.ERC20, label: TokenStandard.ERC20 });
    }
    if (!tokens?.erc721) {
      data.push({ value: TokenStandard.ERC721, label: TokenStandard.ERC721 });
    }
    return data;
  }, [tokens?.erc20, tokens?.erc721]);

  const onSubmit = async (data: z.infer<typeof schema>) => {
    console.log(data);
    // Connect wallet
    if (!isConnected) {
      return await connectWallet();
    }

    // call contract
    if (modelTokenStandard === TokenStandard.ERC20) {
      writeERC20?.();
    } else if (modelTokenStandard === TokenStandard.ERC721) {
      writeERC721?.();
    } else {
      alert('Invalid token standard');
    }
  };

  return (
    <Paper shadow="xs" p="xs" withBorder>
      <Form form={form} onSubmit={onSubmit}>
        <Stack>
          <InputSelect
            name="tokenStandard"
            label="Token standards"
            placeholder="Pick one"
            data={validTokenStandardSelectData}
          />
          <InputText name="name" label="Name" placeholder="eg: name" withAsterisk />
          <InputText name="symbol" label="Symbol" placeholder="eg: symbol" withAsterisk />
          {modelTokenStandard === TokenStandard.ERC20 && (
            <>
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
            </>
          )}
          <Text color="dimmed" size="xs">
            Current ModelId: {modelId}
          </Text>
          {address && (
            <Text color="dimmed" size="xs">
              Current Wallet: {address}
            </Text>
          )}
          {isConnected ? (
            <Button
              type="submit"
              disabled={
                (isModelERC20 && (!writeERC20 || isLoadingERC20)) ||
                (isModelERC721 && (!writeERC721 || isLoadingERC721))
              }
              leftIcon={<IconGavel size={16} />}
            >
              {(isModelERC20 && isLoadingERC20) || (isModelERC721 && isLoadingERC721)
                ? 'Minting...'
                : `Mint ${modelTokenStandard}`}
            </Button>
          ) : (
            <Button onClick={() => connectWallet()} leftIcon={<IconWallet size={16} />}>
              Connect
            </Button>
          )}
          {((isModelERC20 && isSuccessERC20) || (isModelERC721 && isSuccessERC721)) && (
            <Text color="green.8" size="xs">
              Successfully minted!
              <Text td="underline">
                <a
                  href={`${chain.blockExplorers?.etherscan.url}/tx/${
                    isModelERC20 ? dataERC20?.hash : isModelERC721 ? dataERC721?.hash : ''
                  }`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Etherscan
                </a>
              </Text>
            </Text>
          )}
          {renderErrorText({
            isModelERC20,
            isModelERC721,
            isPrepareErrorERC20,
            isPrepareErrorERC721,
            isErrorERC20,
            isErrorERC721,
            prepareErrorERC20,
            prepareErrorERC721,
            errorERC20,
            errorERC721,
          })}
        </Stack>
      </Form>
    </Paper>
  );
}
