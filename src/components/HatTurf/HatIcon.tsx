/** Uses currentColor. */
export function HatIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 3 L19.5 20 H4.5Z" strokeLinejoin="round" />
      <circle cx="12" cy="3.2" r="2.2" />
    </svg>
  );
}
