import { keyframes } from '@mantine/core';

export const wiggle = (amount = 5) =>
  keyframes({
    '0%': {
      transform: 'rotate(0deg)',
    },
    '25%': {
      transform: `rotate(-${amount}deg)`,
    },
    '75%': {
      transform: `rotate(${amount}deg)`,
    },
    '100%': {
      transform: 'rotate(0deg)',
    },
  });

export const jelloVerical = keyframes({
  '0%': {
    transform: 'scale3d(1, 1, 1)',
  },
  '30%': {
    transform: 'scale3d(0.75, 1.25, 1)',
  },
  '40%': {
    transform: 'scale3d(1.25, 0.75, 1)',
  },
  '50%': {
    transform: 'scale3d(0.85, 1.15, 1)',
  },
  '65%': {
    transform: 'scale3d(1.05, 0.95, 1)',
  },
  '75%': {
    transform: 'scale3d(0.95, 1.05, 1)',
  },
  '100%': {
    transform: 'scale3d(1, 1, 1)',
  },
});

export const enterFall = keyframes({
  '0%': {
    transform: 'translateY(-500px)',
    animationTimingFunction: 'ease-in',
    opacity: '0',
  },
  '38%': {
    transform: 'translateY(0)',
    animationTimingFunction: 'ease-out',
    opacity: '1',
  },
  '55%': {
    transform: 'translateY(-65px)',
    animationTimingFunction: 'ease-in',
  },
  '72%': {
    transform: 'translateY(0)',
    animationTimingFunction: 'ease-out',
  },
  '81%': {
    transform: 'translateY(-28px)',
    animationTimingFunction: 'ease-in',
  },
  '90%': {
    transform: 'translateY(0)',
    animationTimingFunction: 'ease-out',
  },
  '95%': {
    transform: 'translateY(-8px)',
    animationTimingFunction: 'ease-in',
  },
  '100%': {
    transform: 'translateY(0)',
    animationTimingFunction: 'ease-out',
  },
});
