import Link, { LinkProps } from 'next/link';

export function NextLink({
  children,
  ...props
}: LinkProps & { children?: React.ReactNode } & Omit<
    React.AnchorHTMLAttributes<HTMLAnchorElement>,
    keyof LinkProps
  >) {
  return (
    <Link prefetch={false} {...props}>
      {children}
    </Link>
  );
}
