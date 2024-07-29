import { Button, ButtonProps, Text } from '@mantine/core';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useGenerationContext } from '~/components/ImageGeneration/GenerationProvider';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function GenerateButton({
  cost = 0,
  loading,
  children = 'Generate',
  error,
  onClick,
  ...buttonProps
}: { cost?: number; loading?: boolean; error?: string; onClick?: () => void } & ButtonProps) {
  const currentUser = useCurrentUser();
  const status = useGenerationStatus();
  const canGenerate = useGenerationContext((state) => state.canGenerate);

  const { size = 'lg' } = buttonProps;

  return !status.charge || !currentUser ? (
    <LoginRedirect reason="image-gen">
      <Button
        {...buttonProps}
        size={size}
        loading={loading}
        disabled={!canGenerate}
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
      disabled={!canGenerate || !cost}
      buzzAmount={cost}
      onPerformTransaction={onClick}
      error={error}
      showPurchaseModal
    />
  );
}
