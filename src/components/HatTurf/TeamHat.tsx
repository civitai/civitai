export function TeamHat({ color, size }: { color: string; size: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      data-testid="hat-turf-cone"
    >
      <path
        d="M12 2.5 L18 17 H6Z"
        fill={color}
        stroke="#fff"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <rect x="7.6" y="12.4" width="8.8" height="2.4" fill="#fff" />
      <circle cx="12" cy="2.6" r="2" fill="#fff" />
    </svg>
  );
}
