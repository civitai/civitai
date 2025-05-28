import type { LinkProps } from 'next/link';
import Link from 'next/link';
import { forwardRef } from 'react';

// export function NextLink({
//   children,
//   ...props
// }: LinkProps & { children?: React.ReactNode } & Omit<
//     React.AnchorHTMLAttributes<HTMLAnchorElement>,
//     keyof LinkProps
//   >) {
//   return (
//     <Link prefetch={false} {...props}>
//       {children}
//     </Link>
//   );
// }

export type NextLinkProps = LinkProps & { children?: React.ReactNode } & Omit<
    React.AnchorHTMLAttributes<HTMLAnchorElement>,
    keyof LinkProps
  >;

export const NextLink = forwardRef<HTMLAnchorElement, NextLinkProps>(
  ({ children, ...props }, ref) => {
    return (
      <Link ref={ref} prefetch={false} {...props}>
        {children}
      </Link>
    );
  }
);

NextLink.displayName = 'NextLink';
