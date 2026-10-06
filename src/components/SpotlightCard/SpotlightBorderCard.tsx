import clsx from 'clsx';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';

type SpotlightStyle = CSSProperties & Record<`--spotlight-${string}`, string | number>;

/**
 * A card whose face AND border light up under the cursor, in one colour. Put a
 * `SpotlightDivider` anywhere inside it and the divider lights from the same cursor.
 *
 * The border is a 1px padded wrapper rather than a CSS `border`, because a border
 * cannot carry a gradient positioned at the cursor.
 */
export function SpotlightBorderCard({
  color,
  size = 240,
  className,
  faceClassName,
  style,
  children,
}: {
  /** Any CSS colour; the face glow uses it at reduced strength, the border at full. */
  color: string;
  /** Radius of the face glow in px. The border glow is two thirds of it. */
  size?: number;
  className?: string;
  faceClassName?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  // Written straight to the element's custom properties, so a mouse move never re-renders.
  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // All reads before any write, so a move costs one layout rather than one per child.
    const rect = el.getBoundingClientRect();
    const children = [...el.querySelectorAll<HTMLElement>('[data-spotlight-local]')].map(
      (child) => [child, child.getBoundingClientRect()] as const
    );
    el.style.setProperty('--spotlight-x', `${e.clientX - rect.left}px`);
    el.style.setProperty('--spotlight-y', `${e.clientY - rect.top}px`);
    el.style.setProperty('--spotlight-opacity', '1');
    for (const [child, box] of children) {
      child.style.setProperty('--spotlight-x', `${e.clientX - box.left}px`);
      child.style.setProperty('--spotlight-y', `${e.clientY - box.top}px`);
    }
  };
  const handleMouseLeave = (e: MouseEvent<HTMLDivElement>) => {
    e.currentTarget.style.setProperty('--spotlight-opacity', '0');
  };

  const vars: SpotlightStyle = {
    '--spotlight-color': color,
    '--spotlight-size': `${size}px`,
    '--spotlight-border-size': `${Math.round((size * 2) / 3)}px`,
    '--spotlight-opacity': 0,
    ...style,
  };

  return (
    <div
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={clsx('relative rounded-md bg-gray-3 p-px dark:bg-dark-4', className)}
      style={vars}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit] transition-opacity duration-300"
        style={{
          opacity: 'var(--spotlight-opacity)',
          background:
            'radial-gradient(var(--spotlight-border-size) circle at var(--spotlight-x) var(--spotlight-y), var(--spotlight-color), transparent 70%)',
        }}
      />
      <div
        className={clsx(
          'relative h-full overflow-hidden rounded-[calc(var(--mantine-radius-md)-1px)] bg-white dark:bg-dark-6',
          faceClassName
        )}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 transition-opacity duration-500"
          style={{
            opacity: 'var(--spotlight-opacity)',
            background:
              'radial-gradient(var(--spotlight-size) circle at var(--spotlight-x) var(--spotlight-y), color-mix(in srgb, var(--spotlight-color) 30%, transparent), transparent 70%)',
          }}
        />
        {children}
      </div>
    </div>
  );
}

/** A 1px rule that lights with its `SpotlightBorderCard`'s cursor, wherever it sits inside the card. */
export function SpotlightDivider({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      data-spotlight-local
      className={clsx('relative h-px w-full bg-gray-2 dark:bg-dark-4', className)}
    >
      <div
        className="absolute inset-0 transition-opacity duration-300"
        style={{
          opacity: 'var(--spotlight-opacity, 0)',
          background:
            'radial-gradient(var(--spotlight-border-size, 160px) circle at var(--spotlight-x) var(--spotlight-y), var(--spotlight-color), transparent 70%)',
        }}
      />
    </div>
  );
}
