import { Table } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import ReactMarkdown from 'react-markdown';
import type { Options } from 'react-markdown';
import clsx from 'clsx';
import ContentErrorBoundary from '~/components/ErrorBoundary/ContentErrorBoundary';
import { useCurrentUser } from '~/hooks/useCurrentUser';

type CustomOptions = Options & {
  allowExternalVideo?: boolean;
};

/**
 * Links for `notranslate` context
 * https://stackoverflow.com/a/65110044
 * https://github.com/facebook/react/issues/11538
 */
export function CustomMarkdown({
  allowExternalVideo,
  components,
  className,
  ...options
}: CustomOptions) {
  const user = useCurrentUser();

  return (
    <ContentErrorBoundary>
      <ReactMarkdown
        {...options}
        className={clsx(className, 'markdown-content')}
        components={{
          ...components,
          a: ({ node, href, ...props }) => {
            if (!href) return <a {...props}>{props.children}</a>;
            if (
              allowExternalVideo &&
              videoKeysRequirements.some((requirements) =>
                requirements.every((item) => href?.includes(item))
              )
            ) {
              return (
                <span className="relative mx-auto mb-3 block aspect-video max-w-sm">
                  <iframe
                    allowFullScreen
                    src={href}
                    className="absolute inset-0 size-full border-none"
                  ></iframe>
                </span>
              );
            }

            const isExternalLink = href.startsWith('http');
            if (typeof window !== 'undefined')
              href = href.replace('//civitai.com', `//${location.host}`);

            href = href.replace(encodeURI('{userId}'), user?.id?.toString() ?? '');

            return (
              <Link legacyBehavior href={href} passHref>
                <a target={isExternalLink ? '_blank' : '_self'} rel="nofollow noreferrer">
                  {props.children}
                </a>
              </Link>
            );
          },
          table: ({ node, children, ref, ...props }) => {
            return (
              <Table {...props} striped withBorder withColumnBorders>
                {children}
              </Table>
            );
          },
        }}
      />
    </ContentErrorBoundary>
  );
}

const videoKeysRequirements = [
  ['youtube', 'embed'],
  ['drive.google.com', 'preview'],
];
