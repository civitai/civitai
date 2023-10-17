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

export const bounceRight = keyframes({
  '0%': {
    transform: 'translateX(48px)',
    animationTimingFunction: 'ease-in',
    opacity: 1,
  },
  '24%': {
    opacity: 1,
  },
  '40%': {
    transform: 'translateX(26px)',
    animationTimingFunction: 'ease-in',
  },
  '65%': {
    transform: 'translateX(13px)',
    animationTimingFunction: 'ease-in',
  },
  '82%': {
    transform: 'translateX(6.5px)',
    animationTimingFunction: 'ease-in',
  },
  '93%': {
    transform: 'translateX(4px)',
    animationTimingFunction: 'ease-in',
  },
  '25%, 55%, 75%, 87%, 98%': {
    transform: 'translateX(0px)',
    animationTimingFunction: 'ease-out',
  },
  '100%': {
    transform: 'translateX(0px)',
    animationTimingFunction: 'ease-out',
    opacity: 1,
  },
});

export const heartbeat = keyframes({
  from: {
    transform: 'scale(1)',
    animationTimingFunction: 'ease-out',
  },
  '10%': {
    transform: 'scale(0.96)',
    animationTimingFunction: 'ease-in',
  },
  '17%': {
    transform: 'scale(0.98)',
    animationTimingFunction: 'ease-out',
  },
  '33%': {
    transform: 'scale(0.94)',
    animationTimingFunction: 'ease-in',
  },
  '45%': {
    transform: 'scale(1)',
    animationTimingFunction: 'ease-out',
  },
});

export const vibrate = (amount = 2) =>
  keyframes({
    '0%': {
      transform: 'translate(0)',
    },
    '20%': {
      transform: `translate(-${amount}px, ${amount}px)`,
    },
    '40%': {
      transform: `translate(-${amount}px, -${amount}px)`,
    },
    '60%': {
      transform: `translate(${amount}px, ${amount}px)`,
    },
    '80%': {
      transform: `translate(${amount}px, -${amount}px)`,
    },
    '100%': {
      transform: 'translate(0)',
    },
  });

export const jelloVertical = keyframes({
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
