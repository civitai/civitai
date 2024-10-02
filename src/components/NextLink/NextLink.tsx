import Link, { LinkProps } from 'next/link';

export function NextLink({children, ...props}: LinkProps & {children?: React.ReactNode;}) {
  return <Link prefetch={false} {...props} >{children}</Link>
}
