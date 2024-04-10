import { TablerIconsProps } from '@tabler/icons-react';

export function IconNose({
  size = 24,
  color = 'currentColor',
  stroke = 2,
  ...props
}: TablerIconsProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      xmlSpace="preserve"
      width={size}
      height={size}
      strokeWidth={stroke}
      stroke={color}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path
        d="M17.1,12.8c0,1.4-1.1,2.5-2.5,2.5c-0.1,0-0.3,0-0.4,0l-0.3,0C13.4,16.8,11.8,18,10,18c-1.8,0-3.4-1.2-3.9-2.8
	l-0.3,0c-0.1,0-0.3,0-0.4,0c-1.4,0-2.5-1.1-2.5-2.5c0-1.4,2.4-3.4,3.5-3.4c0.1,0,0.2-0.1,0.2-0.3l0-0.1c0.2-1.1,0.8-4.8,0.8-4.8
	C7.8,2.9,8.8,2,10,2c1.2,0,2.2,0.9,2.6,2.2c0,0,0.7,3.8,0.8,4.8l0,0c0,0.2,0.1,0.3,0.2,0.3C14.7,9.4,17.1,11.4,17.1,12.8z M5.9,13.3
	c0,0.2-0.1,0.4-0.1,0.6c0,2.3,1.9,4.2,4.2,4.2c2.3,0,4.2-1.9,4.2-4.2c0-0.2,0-0.4-0.1-0.6"
      />
    </svg>
  );
}
