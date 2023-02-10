import { useMantineTheme } from '@mantine/core';

export function CivitaiLinkSvg() {
  const theme = useMantineTheme();
  return (
    <svg
      version="1.1"
      id="Layer_1"
      xmlns="http://www.w3.org/2000/svg"
      x="0"
      y="0"
      viewBox="0 0 578 176"
      // style="enable-background:new 0 0 578 176"
      xmlSpace="preserve"
    >
      <linearGradient
        id="darkGradient"
        gradientUnits="userSpaceOnUse"
        x1="76"
        y1="1026"
        x2="76"
        y2="850.5"
        gradientTransform="matrix(1 0 0 -1 0 1026)"
      >
        <stop offset="0" style={{ stopColor: '#081692' }} />
        <stop offset="1" style={{ stopColor: '#1e043c' }} />
      </linearGradient>
      <path
        d="M0 43.9v87.7l76 43.9 76-43.9V43.9L76 0 0 43.9z"
        style={{ fill: 'url(#darkGradient)' }}
      />
      <linearGradient
        id="lightGradient"
        gradientUnits="userSpaceOnUse"
        x1="76"
        y1="1026"
        x2="76"
        y2="850.4"
        gradientTransform="matrix(1 0 0 -1 0 1026)"
      >
        <stop offset="0" style={{ stopColor: '#1284f7' }} />
        <stop offset="1" style={{ stopColor: '#0a20c9' }} />
      </linearGradient>
      <path
        style={{ fill: 'url(#lightGradient)' }}
        d="m76 27.7 52 30v60l-52 30-52-30v-60l52-30M76 0 0 43.9v87.8l76 43.9 76-43.9V43.9L76 0z"
      />
      <path
        d="m90.8 95.9-14.9 8.5L61 95.9v-17l14.9-8.5 14.9 8.5H109V68.4l-33-19-33 19v38.1l33 19 33-19V95.9H90.8z"
        style={{ fill: '#fff' }}
      />

      <path
        id="pc"
        d="M538 161.5h-76.2c-5.2 0-9.5-4.3-9.5-9.5s4.3-9.5 9.5-9.5h5.8V131H439c-9.4 0-17.1-7.7-17.1-17.1V37.6c0-9.4 7.7-17.1 17.1-17.1h122c9.4 0 17.1 7.7 17.1 17.1v76.2c0 9.4-7.7 17.1-17.1 17.1h-28.6v11.5h5.8c5.2 0 9.5 4.3 9.5 9.5s-4.5 9.6-9.7 9.6zm-51.5-19h26.8V131h-26.8v11.5zm36.3-30.5H559V39.5H440.8V112h82zm38.1-72.5z"
        style={{ fill: theme.colorScheme === 'dark' ? '#fff' : '#333' }}
      />
      <path
        id="line"
        style={{
          fill: 'none',
          stroke: '#ccc',
          strokeWidth: 6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          strokeDasharray: '5.8732,11.7464',
        }}
        d="M206.8 87.5h170.3"
      />
      <path
        id="arrows"
        d="m196.4 102.5-25.9-15 25.9-15zm185.2 0 25.9-15-25.9-15z"
        style={{ fill: '#ccc' }}
      />
    </svg>
  );
}
