import clsx from 'clsx';
import { forwardRef } from 'react';
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  MouseEvent,
  ReactNode,
} from 'react';

type SpotlightStyle = CSSProperties & Record<`--spotlight-${string}`, string | number>;

// Written straight to the element's custom properties, so a mouse move never re-renders.
function handleSpotlightMove(e: MouseEvent<HTMLElement>) {
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
}

function handleSpotlightLeave(e: MouseEvent<HTMLElement>) {
  e.currentTarget.style.setProperty('--spotlight-opacity', '0');
}

type SurfaceBaseProps = {
  /** Any CSS colour; becomes `--spotlight-color` for the glows and dividers inside. */
  color?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
};
type SpotlightSurfaceProps =
  | (SurfaceBaseProps & { as?: 'div' } & Omit<
        HTMLAttributes<HTMLDivElement>,
        keyof SurfaceBaseProps
      >)
  | (SurfaceBaseProps & { as: 'button' } & Omit<
        ButtonHTMLAttributes<HTMLButtonElement>,
        keyof SurfaceBaseProps
      >);

/**
 * Tracks the cursor for every `SpotlightGlow` and `SpotlightDivider` inside it. Renders no
 * glow of its own.
 */
// Forwards its ref: a Mantine `Tooltip` around it attaches to the root element.
export const SpotlightSurface = forwardRef<HTMLElement, SpotlightSurfaceProps>(
  function SpotlightSurface({ as, color, className, style, children, ...rest }, ref) {
    const vars: SpotlightStyle = {
      ...(color ? { '--spotlight-color': color } : {}),
      '--spotlight-opacity': 0,
      ...style,
    };
    const shared = {
      // Composed, not replaced: a wrapping `Tooltip` passes its own mouse handlers in.
      onMouseMove: (e: MouseEvent<HTMLElement>) => {
        handleSpotlightMove(e);
        (rest.onMouseMove as ((e: MouseEvent<HTMLElement>) => void) | undefined)?.(e);
      },
      onMouseLeave: (e: MouseEvent<HTMLElement>) => {
        handleSpotlightLeave(e);
        (rest.onMouseLeave as ((e: MouseEvent<HTMLElement>) => void) | undefined)?.(e);
      },
      className: clsx('relative', className),
      style: vars,
    };

    if (as === 'button')
      return (
        <button
          type="button"
          {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
          {...shared}
          ref={ref as React.Ref<HTMLButtonElement>}
        >
          {children}
        </button>
      );
    return (
      <div
        {...(rest as HTMLAttributes<HTMLDivElement>)}
        {...shared}
        ref={ref as React.Ref<HTMLDivElement>}
      >
        {children}
      </div>
    );
  }
);

/**
 * A layer that glows around the cursor of the nearest `SpotlightSurface`. Positioned
 * absolutely; give the parent `relative`. With `local`, it measures the cursor against
 * itself rather than the surface, for a glow placed away from the surface's origin.
 */
export function SpotlightGlow({
  color = 'var(--spotlight-color)',
  size = 400,
  fade = 70,
  local,
  duration = 500,
  className = 'inset-0',
}: {
  color?: string;
  size?: number;
  /** Where the gradient reaches transparent, as a percentage of `size`. */
  fade?: number;
  local?: boolean;
  /** Fade in/out time in ms. */
  duration?: number;
  /** Placement; defaults to `inset-0`. */
  className?: string;
}) {
  return (
    <div
      aria-hidden
      data-spotlight-local={local || undefined}
      className={clsx('pointer-events-none absolute transition-opacity', className)}
      style={{
        opacity: 'var(--spotlight-opacity, 0)',
        transitionDuration: `${duration}ms`,
        background: `radial-gradient(${size}px circle at var(--spotlight-x) var(--spotlight-y), ${color}, transparent ${fade}%)`,
      }}
    />
  );
}

/**
 * A 1px rule that lights from its surface's cursor. `overlay` draws only the glow, along the
 * top edge of its positioned parent, for a section whose own `border-top` is the rule.
 */
export function SpotlightDivider({
  color = 'var(--spotlight-color)',
  size = 160,
  overlay,
  className,
}: {
  color?: string;
  size?: number;
  overlay?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      data-spotlight-local
      className={clsx(
        'pointer-events-none h-px',
        overlay ? 'absolute inset-x-0 -top-px' : 'relative w-full bg-gray-2 dark:bg-dark-4',
        className
      )}
    >
      <div
        className={clsx(
          'absolute inset-0 transition-opacity',
          overlay ? 'duration-500' : 'duration-300'
        )}
        style={{
          opacity: 'var(--spotlight-opacity, 0)',
          // An overlay lights along its whole edge wherever the cursor is in the surface; an
          // inline rule fades with the cursor's distance from it.
          background: `radial-gradient(${size}px circle at var(--spotlight-x) ${
            overlay ? '50%' : 'var(--spotlight-y)'
          }, ${color}, transparent 70%)`,
        }}
      />
    </div>
  );
}

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
  return (
    <SpotlightSurface
      color={color}
      className={clsx('rounded-md bg-gray-3 p-px dark:bg-dark-4', className)}
      style={style}
    >
      <SpotlightGlow
        size={Math.round((size * 2) / 3)}
        duration={300}
        className="inset-0 rounded-[inherit]"
      />
      <div
        className={clsx(
          'relative h-full overflow-hidden rounded-[calc(var(--mantine-radius-md)-1px)] bg-white dark:bg-dark-6',
          faceClassName
        )}
      >
        <SpotlightGlow
          size={size}
          color="color-mix(in srgb, var(--spotlight-color) 30%, transparent)"
        />
        {children}
      </div>
    </SpotlightSurface>
  );
}
