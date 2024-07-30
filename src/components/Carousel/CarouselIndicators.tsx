import { UnstyledButton } from '@mantine/core';

export function CarouselIndicators({
  indicators,
  index,
  navigate,
}: {
  indicators: number;
  index: number;
  navigate?: (index: number) => void;
}) {
  if (!indicators) return null;

  return (
    <div className="flex justify-center gap-1">
      {new Array(indicators).fill(0).map((_, i) => (
        <UnstyledButton
          key={i}
          data-active={i === index || undefined}
          aria-hidden
          tabIndex={-1}
          onClick={() => navigate?.(i)}
          className={`h-1 max-w-6 flex-1 rounded border border-solid border-gray-4 bg-white shadow-2xl
    ${i !== index ? 'dark:opacity-50' : 'bg-blue-6 dark:bg-white'}`}
        />
      ))}
    </div>
  );
}
