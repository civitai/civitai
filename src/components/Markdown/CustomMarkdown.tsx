import { Table } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import ReactMarkdown from 'react-markdown';
import type { Options } from 'react-markdown';
import clsx from 'clsx';
import ContentErrorBoundary from '~/components/ErrorBoundary/ContentErrorBoundary';
import { LocalTimestamp } from '~/components/LocalTimestamp/LocalTimestamp';
import { remarkTimestamp } from '~/components/Markdown/remark-timestamp';
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
  remarkPlugins,
  allowedElements,
  ...options
}: CustomOptions) {
  const user = useCurrentUser();

  // Discord-style `<t:UNIX:STYLE>` timestamp support is available in every
  // markdown surface. Caller-provided remark plugins still run alongside it.
  const mergedRemarkPlugins = [remarkTimestamp, ...(remarkPlugins ?? [])];

  // Many callers restrict `allowedElements` (e.g. `['a']`), which drops the
  // rendered `<time>` element (keeping only its raw UTC fallback text). Always
  // permit `time` so timestamps render in local time everywhere. When no
  // allowlist is set, everything is allowed already, so leave it undefined.
  // react-markdown forbids passing both `allowedElements` and
  // `disallowedElements`, so only set ours when the caller didn't opt into a
  // denylist instead.
  const mergedAllowedElements =
    allowedElements && !options.disallowedElements
      ? Array.from(new Set([...allowedElements, 'time']))
      : undefined;

  const mergedComponents: Options['components'] = {
    ...components,
    time: ({ node, ...props }) => {
      const properties = (node?.properties ?? {}) as Record<string, unknown>;
      if (properties.dataType !== 'timestamp') return <time {...props}>{props.children}</time>;
      return (
        <LocalTimestamp
          value={String(properties.dataValue ?? '')}
          style={properties.dataStyle as string | undefined}
        />
      );
    },
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
      if (typeof window !== 'undefined') href = href.replace('//civitai.com', `//${location.host}`);

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
        <Table {...props} striped withTableBorder withColumnBorders>
          {children}
        </Table>
      );
    },
    thead: ({ node, children, ref, ...props }) => {
      return <Table.Thead {...props}>{children}</Table.Thead>;
    },
    tbody: ({ node, children, ref, ...props }) => {
      return <Table.Tbody {...props}>{children}</Table.Tbody>;
    },
    tr: ({ node, children, ref, ...props }) => {
      return <Table.Tr {...props}>{children}</Table.Tr>;
    },
    th: ({ node, children, ref, ...props }) => {
      return <Table.Th {...props}>{children}</Table.Th>;
    },
    td: ({ node, children, ref, ...props }) => {
      return <Table.Td {...props}>{children}</Table.Td>;
    },
  };

  return (
    <ContentErrorBoundary>
      <ReactMarkdown
        {...options}
        remarkPlugins={mergedRemarkPlugins}
        allowedElements={mergedAllowedElements}
        className={clsx(className, 'markdown-content')}
        components={mergedComponents}
      />
    </ContentErrorBoundary>
  );
}

const videoKeysRequirements = [
  ['youtube', 'embed'],
  ['drive.google.com', 'preview'],
];
