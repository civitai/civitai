import {
  Badge,
  Button,
  ButtonProps,
  createStyles,
  Group,
  MantineSize,
  Text,
  Tooltip,
} from '@mantine/core';
import { Currency } from '~/shared/utils/prisma/enums';
import { IconAlertTriangleFilled } from '@tabler/icons-react';
import React from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useBuzzTransaction } from './buzz.utils';

type Props = ButtonProps & {
  buzzAmount: number;
  message?: string | ((requiredBalance: number) => string);
  label: React.ReactNode;
  onPerformTransaction?: () => void;
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  size?: MantineSize;
  performTransactionOnPurchase?: boolean;
  showPurchaseModal?: boolean;
  error?: string;
  transactionType?: 'Generation' | 'Default';
  showTypePct?: boolean;
};

const useButtonStyle = createStyles((theme) => ({
  button: {
    color: theme.colors.dark[8],
    fontWeight: 600,

    ['&[data-loading] .mantine-Button-leftIcon']: {
      display: 'none',
    },
  },
}));

export function BuzzTransactionButton({
  buzzAmount,
  onPerformTransaction,
  purchaseSuccessMessage,
  message = "You don't have enough funds. Buy or earn more buzz to perform this action",
  performTransactionOnPurchase = true,
  label,
  size,
  loading,
  showPurchaseModal = true,
  error,
  transactionType,
  showTypePct = false,
  ...buttonProps
}: Props) {
  const features = useFeatureFlags();
  const { classes, cx, theme } = useButtonStyle();
  const {
    conditionalPerformTransaction,
    hasRequiredAmount,
    hasTypeRequiredAmount,
    getTypeDistribution,
    isLoadingBalance,
  } = useBuzzTransaction({
    message,
    purchaseSuccessMessage,
    performTransactionOnPurchase,
    type: transactionType,
  });

  if (!features.buzz) return null;

  const onClick = (e?: React.MouseEvent) => {
    if (!showPurchaseModal) return;

    e?.preventDefault();
    e?.stopPropagation();

    if (!onPerformTransaction) {
      return;
    }

    if (!features.buzz) {
      // Just perform whatever it is we need
      onPerformTransaction();
      return;
    }

    conditionalPerformTransaction(buzzAmount, onPerformTransaction);
  };

  const blueColor = 'blue.4';
  const yellowColor = 'yellow.7';

  const hasCost = buzzAmount > 0;
  const meetsTypeRequiredAmount = hasTypeRequiredAmount(buzzAmount);

  const takesBlue = transactionType === 'Generation';
  const buttonColor = meetsTypeRequiredAmount && takesBlue ? blueColor : yellowColor;

  const typeDistrib = getTypeDistribution(buzzAmount);

  return (
    <Button
      color={error ? 'red.9' : hasCost || loading ? buttonColor : 'blue'}
      {...buttonProps}
      onClick={loading ? undefined : onPerformTransaction ? onClick : undefined}
      className={cx(buttonProps?.className, { [classes.button]: hasCost || loading })}
      pr={hasCost ? 8 : undefined}
      styles={{
        label: {
          width: '100%',
        },
      }}
      size={size}
      loading={loading}
      disabled={buttonProps.disabled || !!error || isLoadingBalance}
    >
      <Group spacing="md" position="apart" noWrap w="100%">
        <Text size={size ?? 14} ta={!hasCost ? 'center' : undefined} sx={{ flex: 1 }}>
          {label}
        </Text>
        {(hasCost || loading) && (
          <CurrencyBadge
            currency={Currency.BUZZ}
            unitAmount={buzzAmount}
            displayCurrency={false}
            radius={buttonProps?.radius ?? 'sm'}
            py={12}
            pl={4}
            pr={8}
            loading={loading}
            textColor={
              meetsTypeRequiredAmount && takesBlue ? theme.colors.blue[4] : theme.colors.yellow[7]
            }
            color={theme.colorScheme === 'dark' ? 'dark.8' : 'gray.9'}
            typeDistrib={showTypePct ? typeDistrib : undefined}
          >
            {!hasRequiredAmount(buzzAmount) && (
              <Tooltip
                label="Insufficient buzz. Click to buy more"
                style={{ textTransform: 'capitalize' }}
                maw={250}
                multiline
                withArrow
                withinPortal
              >
                <IconAlertTriangleFilled
                  color="red"
                  size={12}
                  fill="currentColor"
                  style={{ marginRight: 4 }}
                />
              </Tooltip>
            )}
          </CurrencyBadge>
        )}
        {error && !hasCost && (
          <Tooltip
            label={error ?? 'There was an error'}
            maw={200}
            multiline
            withArrow
            withinPortal
            opened // Forcefully open because button is disabled
            // style={{ whiteSpace: 'normal' }}
          >
            <Badge
              color="dark.8"
              variant="filled"
              radius={buttonProps?.radius ?? 'sm'}
              py={10}
              px={8}
            >
              <IconAlertTriangleFilled color="red" size={12} fill="currentColor" />
            </Badge>
          </Tooltip>
        )}
      </Group>
    </Button>
  );
}
