import { Table } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import ReactMarkdown from 'react-markdown';
import { ReactMarkdownOptions } from 'react-markdown/lib/react-markdown';
import clsx from 'clsx';

type CustomOptions = ReactMarkdownOptions & {
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
  return (
    <ReactMarkdown
      {...options}
      className={clsx(className, 'markdown-content notranslate')}
      components={{
        ...components,
        a: ({ node, href, ...props }) => {
          if (!href) return <a {...props}>{props.children?.[0]}</a>;
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

          return (
            <Link legacyBehavior href={href} passHref>
              <a target={isExternalLink ? '_blank' : '_self'} rel="nofollow noreferrer">
                {props.children?.[0]}
              </a>
            </Link>
          );
        },
        table: ({ node, ...props }) => {
          return (
            <Table {...props} striped withBorder withColumnBorders>
              {props.children}
            </Table>
          );
        },
      }}
    />
  );
}

const videoKeysRequirements = [
  ['youtube', 'embed'],
  ['drive.google.com', 'preview'],
];
