import type { ButtonProps } from '@mantine/core';
import { Button, Text } from '@mantine/core';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useGenerationContext } from '~/components/ImageGeneration/GenerationProvider';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { buzzSpendTypes, BuzzTypes } from '~/shared/constants/buzz.constants';
import type { TransactionInfo } from '@civitai/client';

export function GenerateButton({
  cost = 0,
  loading,
  children = 'Generate',
  error,
  onClick,
  disabled,
  transactions,
  ...buttonProps
}: {
  cost?: number;
  transactions?: TransactionInfo[];
  loading?: boolean;
  error?: string;
  onClick?: () => void;
} & ButtonProps &
  Partial<React.ButtonHTMLAttributes<HTMLButtonElement>>) {
  const currentUser = useCurrentUser();
  const status = useGenerationStatus();
  const canGenerate = useGenerationContext((state) => state.canGenerate);
  const availableBuzzTypes = useAvailableBuzz(['blue']);

  const { size = 'lg' } = buttonProps;
  const accountTypes = transactions
    ? transactions.filter((x) => x.accountType).map((x) => BuzzTypes.toSpendType(x.accountType!))
    : [];

  return !status.charge || !currentUser ? (
    <LoginRedirect reason="image-gen">
      <Button
        {...buttonProps}
        size={size}
        loading={loading}
        disabled={!canGenerate || disabled}
        onClick={onClick}
      >
        <Text ta="center">{children}</Text>
      </Button>
    </LoginRedirect>
  ) : (
    <BuzzTransactionButton
      {...buttonProps}
      size={size}
      label={children}
      loading={loading}
      disabled={!canGenerate || !cost || disabled}
      buzzAmount={cost}
      onPerformTransaction={onClick}
      error={error}
      accountTypes={accountTypes.length > 0 ? accountTypes : availableBuzzTypes}
      showPurchaseModal
      showTypePct
    />
  );
}
