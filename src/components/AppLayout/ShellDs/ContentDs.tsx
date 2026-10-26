import clsx from 'clsx';
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { forwardRef, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NextLinkProps } from '~/components/NextLink/NextLink';
import { NextLink } from '~/components/NextLink/NextLink';
import { useIsomorphicLayoutEffect } from '~/hooks/useIsomorphicLayoutEffect';
import classes from './ContentDs.module.css';

/**
 * Badges, codes, text and tooltips as `@civitai/components` markup — the flag-ON half of
 * `modelPageDesignSystemMarkup`, next to the shell's buttons in `ShellDs.tsx`. As there, the prop
 * NAMES are Mantine's (the contract is visual parity with the Mantine markup each replaces) and
 * `ContentDs.module.css` supplies the Mantine values the design system does not have.
 */

export type DsBadgeColor = 'gray' | 'blue' | 'violet' | 'teal' | 'cyan' | 'yellow' | 'green';
export type DsBadgeVariant = 'light' | 'filled' | 'outline';

type DsBadgeStyleProps = {
  color: DsBadgeColor;
  /** civitai's theme default is `light`. */
  variant?: DsBadgeVariant;
  size?: 'sm' | 'md' | 'lg';
  /** civitai's theme default is `sm`. */
  radius?: 'sm' | 'xl';
  leftSection?: ReactNode;
  className?: string;
  children?: ReactNode;
};

const BADGE_VARIANT_CLASS: Record<DsBadgeVariant, string> = {
  light: classes.badgeLight,
  filled: classes.badgeFilled,
  outline: classes.badgeOutline,
};

function badgeAttributes({
  color,
  variant = 'light',
  size = 'md',
  radius = 'sm',
  leftSection,
  className,
}: Omit<DsBadgeStyleProps, 'children'>) {
  return {
    'data-civitai-ui': 'badge',
    'data-variant': variant,
    'data-size': size,
    className: clsx(
      classes.badge,
      classes[color],
      BADGE_VARIANT_CLASS[variant],
      size === 'sm' && classes.badgeSm,
      size === 'lg' && classes.badgeLg,
      radius === 'xl' && classes.badgeRadiusXl,
      leftSection != null && classes.badgeWithLeft,
      className
    ),
  } as const;
}

function BadgeContent({
  leftSection,
  children,
}: {
  leftSection?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      {leftSection != null && <span className={classes.badgeSection}>{leftSection}</span>}
      {/* `data-badge-label`: what `globals.css` keys Mantine's `.mantine-Badge-label *` rule on. */}
      <span className={classes.badgeLabel} data-badge-label="">
        {children}
      </span>
    </>
  );
}

type DsBadgeProps = DsBadgeStyleProps &
  Omit<HTMLAttributes<HTMLElement>, 'className' | 'children' | 'color'> & {
    /** Mantine's `component="button"`. No `type`, like Mantine's polymorphic badge. */
    component?: 'span' | 'button';
  };

export const DsBadge = forwardRef<HTMLElement, DsBadgeProps>(function DsBadge(
  { color, variant, size, radius, leftSection, className, children, component = 'span', ...rest },
  ref
) {
  const attrs = badgeAttributes({ color, variant, size, radius, leftSection, className });
  const content = <BadgeContent leftSection={leftSection}>{children}</BadgeContent>;
  if (component === 'button')
    return (
      <button ref={ref as React.Ref<HTMLButtonElement>} {...rest} {...attrs}>
        {content}
      </button>
    );
  return (
    <span ref={ref as React.Ref<HTMLSpanElement>} {...rest} {...attrs}>
      {content}
    </span>
  );
});

type DsBadgeLinkProps = DsBadgeStyleProps & { href: string } & Omit<
    NextLinkProps,
    'href' | 'className' | 'children' | 'color'
  >;

/** Mantine `<Badge component="a">` inside `<Link legacyBehavior passHref>`. */
export const DsBadgeLink = forwardRef<HTMLAnchorElement, DsBadgeLinkProps>(function DsBadgeLink(
  { color, variant, size, radius, leftSection, className, children, href, ...rest },
  ref
) {
  return (
    <NextLink
      ref={ref}
      href={href}
      {...rest}
      {...badgeAttributes({ color, variant, size, radius, leftSection, className })}
    >
      <BadgeContent leftSection={leftSection}>{children}</BadgeContent>
    </NextLink>
  );
});

type DsTextProps = {
  size?: 'xs' | 'sm' | 'md';
  dimmed?: boolean;
  className?: string;
  children?: ReactNode;
};

/** Mantine `Text`: a `<p>`. */
export function DsText({ size = 'md', dimmed, className, children }: DsTextProps) {
  return (
    <p
      className={clsx(
        classes.text,
        size === 'xs' && classes.textXs,
        size === 'sm' && classes.textSm,
        dimmed && classes.dimmed,
        className
      )}
    >
      {children}
    </p>
  );
}

/** Mantine `Title order={1} lineClamp={2}`. */
export function DsTitle({ className, children }: { className?: string; children?: ReactNode }) {
  return <h1 className={clsx(classes.title, className)}>{children}</h1>;
}

type DsCodeProps = {
  /** Mantine's `color="blue"`. */
  blue?: boolean;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'className' | 'children' | 'color'>;

/** Mantine `Code` (inline). */
export const DsCode = forwardRef<HTMLElement, DsCodeProps>(function DsCode(
  { blue, className, children, ...rest },
  ref
) {
  return (
    <code ref={ref} {...rest} className={clsx(classes.code, blue && classes.codeBlue, className)}>
      {children}
    </code>
  );
});

/** Mantine Tooltip's `offset` (5) plus half its `arrowSize` (4), which it adds when `withArrow`. */
const TOOLTIP_GAP = 7;
const VIEWPORT_PADDING = 5;

type BubblePosition = { top: number; left: number; arrowLeft: number; below: boolean };

/**
 * Mantine `Tooltip` (civitai's theme turns on `withArrow`), without Mantine's per-instance
 * floating-ui setup on every render. The server renders only the wrapper and the trigger; the
 * bubble exists only while it is open, in `document.body`, so no `overflow: hidden` ancestor can
 * clip it. Placed above the trigger, or below it when there is no room above, and kept inside the
 * viewport horizontally.
 *
 * Opens on mouse (and pen) hover only, like Mantine's defaults (`events: { hover: true, focus:
 * false, touch: false }`). Hover is tracked with NATIVE listeners: React's synthetic enter/leave
 * follow the React tree, so a portaled descendant (the Share popover) would keep the tooltip open
 * and reopen it, where Mantine's floating-ui follows the DOM. While open, the reference carries
 * `aria-describedby` and Escape dismisses it (Mantine's `useRole` and `useDismiss`). `opened` makes
 * it controlled, as on Mantine: hover and Escape then do nothing.
 */
export function DsTooltip({
  label,
  opened,
  className,
  children,
}: {
  label: ReactNode;
  opened?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [position, setPosition] = useState<BubblePosition | null>(null);
  const bubbleId = useId();
  const open = opened ?? hovered;
  const controlled = opened !== undefined;

  const place = useCallback(() => {
    const wrapper = wrapperRef.current;
    const bubble = bubbleRef.current;
    if (!wrapper || !bubble) return;
    const target = (wrapper.firstElementChild as HTMLElement | null) ?? wrapper;
    const anchor = target.getBoundingClientRect();
    const { width, height } = bubble.getBoundingClientRect();
    const below = anchor.top - TOOLTIP_GAP - height < 0;
    const center = anchor.left + anchor.width / 2;
    const maxLeft = window.innerWidth - VIEWPORT_PADDING - width;
    const left = Math.max(VIEWPORT_PADDING, Math.min(center - width / 2, maxLeft));
    setPosition({
      top: below ? anchor.bottom + TOOLTIP_GAP : anchor.top - TOOLTIP_GAP - height,
      left,
      arrowLeft: center - left - 2,
      below,
    });
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, label, place]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || controlled) return;
    const handler = (value: boolean) => (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') setHovered(value);
    };
    const enter = handler(true);
    const leave = handler(false);
    wrapper.addEventListener('pointerenter', enter);
    wrapper.addEventListener('pointerleave', leave);
    return () => {
      wrapper.removeEventListener('pointerenter', enter);
      wrapper.removeEventListener('pointerleave', leave);
    };
  }, [controlled]);

  useEffect(() => {
    const reference = wrapperRef.current?.firstElementChild;
    if (!open || !reference) return;
    const previous = reference.getAttribute('aria-describedby');
    reference.setAttribute('aria-describedby', bubbleId);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !controlled) setHovered(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previous === null) reference.removeAttribute('aria-describedby');
      else reference.setAttribute('aria-describedby', previous);
    };
  }, [open, controlled, bubbleId]);

  const bubbleStyle: CSSProperties = position
    ? { top: position.top, left: position.left }
    : { top: 0, left: 0, visibility: 'hidden' };

  return (
    <span ref={wrapperRef} data-civitai-ui="tooltip" className={clsx(classes.tooltip, className)}>
      {children}
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <span
            ref={bubbleRef}
            id={bubbleId}
            data-civitai-ui-tooltip-bubble=""
            data-open="true"
            role="tooltip"
            className={classes.bubble}
            style={bubbleStyle}
          >
            {label}
            <span
              className={classes.arrow}
              style={{
                left: position?.arrowLeft ?? 0,
                ...(position?.below ? { top: -2 } : { bottom: -2 }),
              }}
            />
          </span>,
          document.body
        )}
    </span>
  );
}
