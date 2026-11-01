import clsx from 'clsx';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import type { NextLinkProps } from '~/components/NextLink/NextLink';
import { NextLink } from '~/components/NextLink/NextLink';
import classes from './ShellDs.module.css';

/**
 * The page shell's buttons, links and icon buttons as `@civitai/components` markup — the
 * flag-ON half of `shellDesignSystemMarkup`. Each call site keeps its Mantine JSX as the flag-OFF
 * half, so turning the flag off restores the shell byte-for-byte.
 *
 * Why this exists: a Mantine `Button`/`ActionIcon` resolves its styles PER INSTANCE on every
 * render (style-prop extraction, prop filtering, class/vars resolution), and the shell renders
 * dozens of them on every page. These components are plain elements with static attributes and
 * module classes — no per-instance style work at all.
 *
 * The NAMES below are Mantine's (`subtle` + `gray`, `xs`, an `ActionIcon` `lg`), because the
 * contract is visual parity with the Mantine shell; `toDesignSystemAttributes` maps each onto the
 * nearest `data-variant`/`data-size` the design system documents, and `ShellDs.module.css`
 * supplies the exact Mantine values the design system does not have.
 */

export type ShellVariant =
  | 'subtle-gray'
  | 'filled'
  | 'filled-red'
  | 'default'
  | 'filled-gray'
  | 'filled-blue'
  | 'filled-green'
  | 'light-gray'
  | 'light-green'
  | 'outline-gray'
  | 'transparent-gray';
/** Mantine `Button` sizes. */
export type ShellSize = 'xs' | 'sm' | 'compact-sm';
/** Mantine `ActionIcon` sizes; set this instead of `size` for an icon-only button. */
export type ShellIconSize = 'xs' | 'md' | 'lg';

type ShellStyleProps = {
  variant: ShellVariant;
  size?: ShellSize;
  icon?: ShellIconSize;
  radius?: 'xl';
  /** Mantine's `fullWidth`. */
  fullWidth?: boolean;
  className?: string;
};

/** The design-system variant each shell variant renders as (`MARKUP.md`: filled · light · outline · subtle). */
export const DS_VARIANT = {
  'subtle-gray': 'subtle',
  filled: 'filled',
  'filled-red': 'filled',
  default: 'outline',
  'filled-gray': 'filled',
  'filled-blue': 'filled',
  'filled-green': 'filled',
  'light-gray': 'light',
  'light-green': 'light',
  'outline-gray': 'outline',
  'transparent-gray': 'subtle',
} as const satisfies Record<ShellVariant, 'filled' | 'light' | 'outline' | 'subtle'>;

/** The design-system size each shell size renders as (`MARKUP.md`: sm · md · lg). */
export const DS_SIZE = {
  xs: 'sm',
  sm: 'md',
  'compact-sm': 'sm',
  'icon-xs': 'sm',
  'icon-md': 'sm',
  'icon-lg': 'md',
} as const;

const VARIANT_CLASS: Record<ShellVariant, string> = {
  'subtle-gray': classes.subtleGray,
  filled: classes.filledPrimary,
  'filled-red': classes.filledRed,
  default: classes.default,
  'filled-gray': classes.filledGray,
  'filled-blue': classes.filledBlue,
  'filled-green': classes.filledGreen,
  'light-gray': classes.lightGray,
  'light-green': classes.lightGreen,
  'outline-gray': classes.outlineGray,
  'transparent-gray': classes.transparentGray,
};

const SIZE_CLASS: Record<ShellSize, string> = {
  xs: classes.sizeXs,
  sm: classes.sizeSm,
  'compact-sm': classes.sizeCompactSm,
};

const ICON_CLASS: Record<ShellIconSize, string> = {
  xs: classes.iconXs,
  md: classes.iconMd,
  lg: classes.iconLg,
};

export function toDesignSystemAttributes({
  variant,
  size = 'sm',
  icon,
  radius,
  fullWidth,
  className,
}: ShellStyleProps) {
  return {
    'data-civitai-ui': 'button',
    'data-variant': DS_VARIANT[variant],
    'data-size': DS_SIZE[icon ? (`icon-${icon}` as const) : size],
    ...(fullWidth ? { 'data-full-width': 'true' } : {}),
    className: clsx(
      classes.root,
      VARIANT_CLASS[variant],
      icon ? ICON_CLASS[icon] : SIZE_CLASS[size],
      radius === 'xl' && classes.radiusXl,
      fullWidth && classes.fullWidth,
      className
    ),
  } as const;
}

type ShellLinkProps = ShellStyleProps & {
  href: string;
  children?: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'className' | 'children'>;

/**
 * A link styled as a button. Same element choice as the Mantine footer: a `target="_blank"` link
 * is a plain `<a>`, everything else goes through `NextLink` for client-side navigation.
 */
export const ShellLink = forwardRef<HTMLAnchorElement, ShellLinkProps>(function ShellLink(
  { variant, size, icon, radius, fullWidth, className, href, children, ...rest },
  ref
) {
  const attrs = toDesignSystemAttributes({ variant, size, icon, radius, fullWidth, className });
  if (rest.target === '_blank') {
    return (
      <a ref={ref} href={href} {...rest} {...attrs}>
        {children}
      </a>
    );
  }
  return (
    <NextLink ref={ref} href={href} {...(rest as Omit<NextLinkProps, 'href'>)} {...attrs}>
      {children}
    </NextLink>
  );
});

type ShellButtonProps = ShellStyleProps & {
  children?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>;

/** A native `<button>`, `type="button"` like Mantine's, so it never submits an enclosing form. */
export const ShellButton = forwardRef<HTMLButtonElement, ShellButtonProps>(function ShellButton(
  { variant, size, icon, radius, fullWidth, className, children, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      {...rest}
      {...toDesignSystemAttributes({ variant, size, icon, radius, fullWidth, className })}
    >
      {children}
    </button>
  );
});

/**
 * Mantine `Divider orientation="vertical"`: the same `role` and `data-orientation`, and — like
 * Mantine's — no `aria-orientation`, so the accessibility tree is unchanged.
 */
export function ShellDivider() {
  return <div role="separator" data-orientation="vertical" className={classes.divider} />;
}
