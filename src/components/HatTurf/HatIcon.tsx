/** Uses currentColor. Drawn like a Tabler outline icon: 24 grid, 2px stroke. */
export function HatIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="4.1" r="2.8" fill="currentColor" stroke="none" />
      <path d="M5 20 L10.3 10.4 Q12 8.2 13.7 10.4 L19 20" />
      <path d="M5 20 Q12 22.4 19 20" />
    </svg>
  );
}
