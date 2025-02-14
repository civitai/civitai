import { Button, ButtonProps, Text } from '@mantine/core';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useGenerationContext } from '~/components/ImageGeneration/GenerationProvider';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useGenerationStore } from '~/store/generation.store';

export function GenerateButton({
  cost = 0,
  loading,
  children = 'Generate',
  error,
  onClick,
  disabled,
  ...buttonProps
}: { cost?: number; loading?: boolean; error?: string; onClick?: () => void } & ButtonProps) {
  const currentUser = useCurrentUser();
  const status = useGenerationStatus();
  const canGenerate = useGenerationContext((state) => state.canGenerate);
  const close = useGenerationStore((state) => state.close);
  const isMobile = useIsMobile();

  const { size = 'lg' } = buttonProps;

  return !status.charge || !currentUser ? (
    <LoginRedirect reason="image-gen" beforeRedirect={() => {
      if (isMobile) close();
    }}>
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
      transactionType="Generation"
      showPurchaseModal
      showTypePct
    />
  );
}
