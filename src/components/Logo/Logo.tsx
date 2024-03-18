/* eslint-disable @next/next/no-img-element */
import { Box, BoxProps, createStyles, keyframes } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { useMemo } from 'react';
import { LiveNowIndicator } from '~/components/Social/LiveNow';

const gradients = {
  blue: {
    inner: ['#081692', '#1E043C'],
    outer: ['#1284F7', '#0A20C9'],
  },
  halloween: {
    inner: ['#926711', '#3C1F0E'],
    outer: ['#F78C22', '#C98C17'],
  },
  christmas: {
    inner: ['#126515', '#070F0C'],
    outer: ['#45A72A', '#377B39'],
  },
  newyear: {
    inner: ['#081692', '#1E043C'],
    outer: ['#1284F7', '#0A20C9'],
  },
  stpatty: {
    inner: ['#135F20', '#020709'],
    outer: ['#53C42B', '#1D962F'],
  },
};

export function Logo({ ...props }: LogoProps) {
  const { classes, cx } = useStyles();
  const [showHoliday] = useLocalStorage({ key: 'showDecorations', defaultValue: true });
  const holiday = useMemo(() => {
    if (!showHoliday) return null;

    const month = new Date().getMonth();
    const day = new Date().getDate();

    // Halloween
    if (new Date().getMonth() === 9) return 'halloween';

    // Christmas
    if ((month === 10 && day >= 22) || (month === 11 && day <= 25)) return 'christmas';

    // New Year
    if (month === 11 && day >= 26) return 'newyear';
    if (month === 2 && day >= 14 && day <= 17) return 'stpatty';

    return null;
  }, [showHoliday]);

  const holidayClass = holiday ? classes[holiday] : null;
  const innerGradient = holiday ? gradients[holiday].inner : gradients.blue.inner;
  const outerGradient = holiday ? gradients[holiday].outer : gradients.blue.outer;

  return (
    <Box className={cx(classes.root, holidayClass)} {...props}>
      {holiday === 'halloween' && (
        <img src="/images/holiday/ghost.png" alt="ghost" className={classes.flyOver} />
      )}
      {holiday === 'christmas' && (
        <>
          <img src="/images/holiday/santa-hat.png" alt="santa hat" className={classes.hat} />
          <div className={classes.deer}>
            <img src="/images/holiday/deer.png" alt="deer" id="deer" />
            <img src="/images/holiday/deer-nose.png" alt="deer nose" id="nose" />
            <img src="/images/holiday/deer-glow.png" alt="deer glow" id="glow" />
          </div>
        </>
      )}
      <svg className={classes.svg} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 107 22.7">
        <g className={classes.text}>
          <path
            className={classes.c}
            d="M20.8,1.7H3.7L1.5,4.1v15l2.3,2.3h17.1v-5.2H6.7V7h14.1V1.7z"
          />
          <path
            className={classes.ivit}
            d="M76.1,1.7H56.6V7h7.2v14.3H69V7h7C76,7,76.1,1.7,76.1,1.7z M23.2,1.8v19.5h5.2V1.8C28.4,1.8,23.2,1.8,23.2,1.8z M30.8,1.8
      v19.5h7.6l8.3-8.3V1.8h-5.2v8.3l-5.4,6V1.8C36.1,1.8,30.8,1.8,30.8,1.8z M49.1,1.8v19.5h5.2V1.8C54.3,1.8,49.1,1.8,49.1,1.8z"
          />
          <path
            className={classes.ai}
            d="M100.3,1.8v19.5h5.2V1.8H100.3z M95.6,1.8H80.8l-2.3,2.3v17.2h5.2v-7.1h8.9v7.1h5.2V4.1C97.8,4.1,95.6,1.8,95.6,1.8z
      M92.7,8.9h-8.9V7h8.9V8.9z"
          />
          <path className={classes.accent} d="M46.7,16.2v5.1h-5.1" />
        </g>
        <g className={classes.badge}>
          <linearGradient
            id="innerGradient"
            gradientUnits="userSpaceOnUse"
            x1="10.156"
            y1="22.45"
            x2="10.156"
            y2="2.4614"
            gradientTransform="matrix(1 0 0 -1 0 24)"
          >
            <stop offset="0" style={{ stopColor: innerGradient[0] }} />
            <stop offset="1" style={{ stopColor: innerGradient[1] }} />
          </linearGradient>
          <linearGradient
            id="outerGradient"
            gradientUnits="userSpaceOnUse"
            x1="10.156"
            y1="22.45"
            x2="10.156"
            y2="2.45"
            gradientTransform="matrix(1 0 0 -1 0 24)"
          >
            <stop offset="0" style={{ stopColor: outerGradient[0] }} />
            <stop offset="1" style={{ stopColor: outerGradient[1] }} />
          </linearGradient>
          <path
            style={{ fill: 'url(#innerGradient)' }}
            d="M1.5,6.6v10l8.7,5l8.7-5v-10l-8.7-5L1.5,6.6z"
          />
          <path
            style={{ fill: 'url(#outerGradient)' }}
            d="M10.2,4.7l5.9,3.4V15l-5.9,3.4L4.2,15V8.1
		L10.2,4.7 M10.2,1.6l-8.7,5v10l8.7,5l8.7-5v-10C18.8,6.6,10.2,1.6,10.2,1.6z"
          />
          <path
            style={{ fill: '#fff' }}
            d="M11.8,12.4l-1.7,1l-1.7-1v-1.9l1.7-1l1.7,1h2.1V9.3l-3.8-2.2L6.4,9.3v4.3l3.8,2.2l3.8-2.2v-1.2H11.8z"
          />
        </g>
      </svg>
      <LiveNowIndicator className={classes.liveNow} />
    </Box>
  );
}

type LogoProps = {
  size?: 'sm' | 'md' | 'lg' | 'xl';
} & BoxProps;

const useStyles = createStyles((theme, _, getRef) => ({
  root: {
    height: 30,
    position: 'relative',
    [theme.fn.smallerThan('sm')]: {
      height: 45,
      width: 45,
    },
  },
  svg: {
    ref: getRef('svg'),
    height: 30,
    [theme.fn.smallerThan('sm')]: {
      height: 45,
    },
  },
  c: {
    ref: getRef('c'),
    fill: theme.colorScheme === 'dark' ? theme.colors.dark[0] : '#222',
  },

  ivit: {
    ref: getRef('ivit'),
    fill: theme.colorScheme === 'dark' ? theme.colors.dark[0] : '#222',
  },

  ai: {
    ref: getRef('ai'),
    fill: theme.colors.blue[8],
  },

  accent: {
    ref: getRef('accent'),
    fill: theme.colors.blue[8],
  },

  text: {
    [theme.fn.smallerThan('sm')]: {
      display: 'none',
    },
  },

  badge: {
    ref: getRef('badge'),
    [theme.fn.largerThan('sm')]: {
      display: 'none',
    },
  },

  liveNow: {
    position: 'absolute',
    bottom: -13,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 3,
    background: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[1],
    [theme.fn.smallerThan('sm')]: {
      bottom: -7,
    },
  },

  flyOver: {
    ref: getRef('flyOver'),
    position: 'absolute',
    height: 45,
    [theme.fn.smallerThan('sm')]: {
      height: 40,
    },
  },

  deer: {
    ref: getRef('deer'),
    position: 'absolute',
    height: 60,
    width: 60,
    zIndex: 3,

    img: {
      position: 'absolute',
      height: '100%',

      '&#deer': {},
      '&#nose': {
        zIndex: 2,
      },
      '&#glow': {
        opacity: 0,
        zIndex: 1,
        animation: `${twinkle} 1s ease infinite`,
      },
    },

    [theme.fn.smallerThan('sm')]: {
      height: 40,
      width: 40,
    },
  },

  hat: {
    position: 'absolute',
    height: 25,
    left: 0,
    top: 0,
    transform: 'rotate(-20deg) translate(-14%, -75%)',
    zIndex: 3,
    [theme.fn.smallerThan('sm')]: {
      display: 'none',
    },
  },

  halloween: {
    [`.${getRef('ai')}`]: {
      fill: theme.colors.orange[6],
    },
    [`.${getRef('accent')}`]: {
      fill: theme.colors.orange[6],
    },
    [`.${getRef('svg')}`]: {
      position: 'relative',
      zIndex: 2,
    },
    [`.${getRef('flyOver')}`]: {
      zIndex: 3,
      animation: `${flyOver} 8s 4s ease`,
      opacity: 0,
      [theme.fn.smallerThan('sm')]: {
        transform: 'rotate(20deg)',
        animation: `${peekOut} 5s ease infinite alternate`,
        zIndex: 1,
      },
    },
  },

  christmas: {
    [`.${getRef('ai')}`]: {
      fill: theme.colors.red[8],
    },
    [`.${getRef('accent')}`]: {
      fill: theme.colors.red[8],
    },
    [`.${getRef('svg')}`]: {
      position: 'relative',
      zIndex: 2,
    },
    [`.${getRef('deer')}`]: {
      zIndex: 3,
      animation: `${prance} 3s 4s linear`,
      opacity: 0,
      [theme.fn.smallerThan('sm')]: {
        transform: 'rotate(-20deg)',
        animation: `${peekOutDeer} 5s ease infinite alternate`,
        zIndex: 1,
      },
    },
  },

  newyear: {},
  stpatty: {
    [`.${getRef('ai')}`]: {
      fill: theme.colors.green[8],
    },
    [`.${getRef('accent')}`]: {
      fill: theme.colors.green[8],
    },
  },
}));

const flyOver = keyframes({
  '0%': {
    top: 5,
    left: '-10%',
    opacity: 0,
    transform: 'scale(0.5) rotate(0deg)',
  },
  '15%': {
    top: -10,
    left: '5%',
    opacity: 1,
    transform: 'scale(1) rotate(2deg)',
  },
  '30%': {
    top: 0,
    left: '70%',
    opacity: 0.8,
    transform: 'scale(1) rotate(15deg)',
  },
  ['40%, 100%']: {
    top: -5,
    left: '70%',
    opacity: 0,
    transform: 'scale(0.5) rotate(-10deg)',
  },
});

const prance = keyframes({
  '0%': {
    top: 0,
    left: '-20%',
    opacity: 0,
    transform: 'scale(0.5) rotate(-15deg)',
  },
  '15%': {
    top: -25,
    left: '0%',
    opacity: 1,
    transform: 'scale(1) rotate(-15deg)',
  },
  '50%': {
    top: -40,
    left: '30%',
    opacity: 1,
    transform: 'scale(1) rotate(0deg)',
  },
  '85%': {
    top: -25,
    left: '70%',
    opacity: 0.8,
    transform: 'scale(1) rotate(15deg)',
  },
  '100%': {
    top: 0,
    left: '80%',
    opacity: 0,
    transform: 'scale(0.5) rotate(15deg)',
  },
});

const twinkle = keyframes({
  '0%': {
    opacity: 0,
  },
  '50%': {
    opacity: 1,
  },
  '100%': {
    opacity: 0,
  },
});

const peekOut = keyframes({
  '0%': {
    top: 5,
    right: 10,
    opacity: 0,
    transform: 'scale(0.5) rotate(0deg)',
  },
  '30%': {
    top: -12,
    right: -12,
    opacity: 1,
    transform: 'scale(1) rotate(40deg)',
  },
  '60%': {
    top: -12,
    right: -12,
    opacity: 1,
    transform: 'scale(1) rotate(40deg)',
  },
  '100%': {
    top: 5,
    right: 10,
    opacity: 0,
    transform: 'scale(0.5) rotate(0deg)',
  },
});

const peekOutDeer = keyframes({
  '0%': {
    top: 0,
    right: 0,
    opacity: 0,
    transform: 'scale(0.5)',
  },
  '60%': {
    top: -10,
    right: -12,
    opacity: 1,
    transform: 'scale(1)',
  },
  '100%': {
    top: 0,
    right: 0,
    opacity: 0,
    transform: 'scale(0.5)',
  },
});
