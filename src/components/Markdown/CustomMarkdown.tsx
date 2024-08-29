import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import { ReactMarkdownOptions } from 'react-markdown/lib/react-markdown';
import rehypeRaw from 'rehype-raw';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

type CustomOptions = Omit<ReactMarkdownOptions, 'className'> & {
  allowExternalVideo?: boolean;
};

export function CustomMarkdown({ allowExternalVideo, ...options }: CustomOptions) {
  return (
    <ReactMarkdown
      {...options}
      rehypePlugins={[rehypeRaw]}
      className="markdown-content"
      components={{
        a: ({ node, href, ...props }) => {
          if (!href) return <a {...props}>{props.children?.[0]}</a>;
          if (
            allowExternalVideo &&
            videoKeysRequirements.some((requirements) =>
              requirements.every((item) => href?.includes(item))
            )
          ) {
            return (
              <div className="relative mx-auto aspect-video max-w-sm">
                <iframe
                  allowFullScreen
                  src={href}
                  className="absolute inset-0 border-none"
                ></iframe>
              </div>
            );
          }

          const isExternalLink = href.startsWith('http');
          if (typeof window !== 'undefined')
            href = href.replace('//civitai.com', `//${location.host}`);

          return (
            <Link href={href} passHref>
              <a target={isExternalLink ? '_blank' : '_self'} rel="nofollow noreferrer">
                {props.children?.[0]}
              </a>
            </Link>
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
