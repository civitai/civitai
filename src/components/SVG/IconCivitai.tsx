import { TablerIconsProps } from '@tabler/icons-react';
export function IconCivitai({
  size = 24,
  color = 'currentColor',
  stroke = 0,
  ...props
}: TablerIconsProps) {
  return (
    <svg
      viewBox="0 0 178 178"
      width={size}
      height={size}
      strokeWidth={stroke}
      stroke={color}
      fill={color}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M89.3,29.2l52,30v60l-52,30l-52-30v-60L89.3,29.2 M89.3,1.5l-76,43.9v87.8l76,43.9l76-43.9V45.4L89.3,1.5z" />
      <path d="M104.1,97.2l-14.9,8.5l-14.9-8.5v-17l14.9-8.5l14.9,8.5h18.2V69.7l-33-19l-33,19v38.1l33,19l33-19V97.2H104.1z" />
    </svg>
  );
}
