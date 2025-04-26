import {
  Group,
  Loader,
  MantineSize,
  Text,
  TextProps,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { abbreviateNumber } from '~/utils/number-helpers';
import type { BuzzAccountType } from '~/server/schema/buzz.schema';
import { CurrencyConfig } from '~/server/common/constants';
import styles from './UserBuzz.module.scss';

type Props = TextProps & {
  iconSize?: number;
  textSize?: MantineSize;
  withTooltip?: boolean;
  withAbbreviation?: boolean;
  accountId?: number;
  accountType?: BuzzAccountType | null;
  theme?: string;
};

export function UserBuzz({
  iconSize = 20,
  textSize = 'md',
  withTooltip,
  withAbbreviation = true,
  accountId,
  accountType,
  ...textProps
}: Props) {
  const { balance, balanceLoading } = useBuzz(accountId, accountType);
  const config = CurrencyConfig.BUZZ.themes?.[accountType ?? ''] ?? CurrencyConfig.BUZZ;
  const Icon = config.icon;
  const theme = useMantineTheme();

  const themeClass =
    styles[`theme${accountType?.charAt(0).toUpperCase() + accountType?.slice(1) ?? 'Default'}`];

  const content = balanceLoading ? (
    <div className={styles.loadingContainer}>
      <Icon size={iconSize} className={styles.buzzIcon} />
      <Loader className={styles.loadingDots} variant="dots" size="xs" />
    </div>
  ) : (
    <div className={`${styles.buzzContainer} ${themeClass}`}>
      <Icon size={iconSize} className={styles.buzzIcon} />
      <Text size={textSize} className={styles.buzzAmount}>
        {balance === null ? (
          <Loader size="sm" variant="dots" />
        ) : withAbbreviation ? (
          abbreviateNumber(balance, { floor: true })
        ) : (
          balance.toLocaleString()
        )}
      </Text>
    </div>
  );

  return withTooltip ? (
    <Tooltip
      label={`Total balance: ${balance === null ? '(Loading...)' : balance.toLocaleString()}`}
    >
      {content}
    </Tooltip>
  ) : (
    content
  );
}

