import { createStyles, keyframes } from '@mantine/core';
import { BuzzWithdrawalRequestStatus } from '@prisma/client';

const moveBackground = keyframes({
  '0%': {
    backgroundPosition: '0% 50%',
  },
  '50%': {
    backgroundPosition: '100% 50%',
  },
  '100%': {
    backgroundPosition: '0% 50%',
  },
});

const pulse = keyframes({
  '0%': {
    stroke: '#FFD43B',
    opacity: 1,
  },
  '50%': {
    stroke: '#F59F00',
    opacity: 0.7,
  },
  '100%': {
    stroke: '#F08C00',
    opacity: 1,
  },
});

export const useBuzzDashboardStyles = createStyles((theme) => ({
  lifetimeBuzzContainer: {
    border: `2px solid ${theme.colors.yellow[7]}`,
    background: theme.fn.linearGradient(45, theme.colors.yellow[4], theme.colors.yellow[1]),
    animation: `${moveBackground} 5s ease infinite`,
    backgroundSize: '200% 200%',
  },
  goldText: {
    background: theme.fn.linearGradient(45, theme.colors.yellow[4], theme.colors.yellow[1]),
    fontWeight: 800,
    backgroundClip: 'text',
    color: 'transparent',
  },
  lifetimeBuzzBadge: {
    background: theme.colors.dark[6],
    borderRadius: '22px',
    padding: '10px 20px',
  },
  tileCard: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[0],
  },
  lifetimeBuzz: {
    animation: `${pulse} 1s ease-in-out infinite`,
  },
}));

export const WithdrawalRequestBadgeColor = {
  [BuzzWithdrawalRequestStatus.Requested]: 'yellow',
  [BuzzWithdrawalRequestStatus.Approved]: 'blue',
  [BuzzWithdrawalRequestStatus.Transferred]: 'green',
  [BuzzWithdrawalRequestStatus.Canceled]: 'gray',
  [BuzzWithdrawalRequestStatus.Rejected]: 'red',
  [BuzzWithdrawalRequestStatus.Reverted]: 'orange',
  [BuzzWithdrawalRequestStatus.ExternallyResolved]: 'lime',
};
