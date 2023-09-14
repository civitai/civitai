import { createStyles } from '@mantine/core';
import { useMemo } from 'react';
import { InstagramEmbed, TwitterEmbed, YouTubeEmbed } from 'react-social-media-embed';
import { SocialBlockSchema } from '~/server/schema/home-block.schema';

export type SocialBlockProps = {
  url: string;
  type: 'ig-reel' | 'ig-post' | 'yt-short' | 'yt-long' | 'tw-post';
};

const typeHeight: Partial<Record<SocialBlockSchema['type'], number>> = {
  'ig-reel': 505,
  'ig-post': 425,
  'yt-short': 569,
  'yt-long': 369,
};

const useStyles = createStyles((theme, { type }: { type: SocialBlockSchema['type'] }) => ({
  card: {
    borderRadius: theme.radius.md,
    overflow: 'hidden',
    height: typeHeight[type],
    background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    iframe: {
      border: 'none !important',
    },
    [theme.fn.largerThan('sm')]: {
      gridColumn: type === 'yt-long' ? 'span 2' : undefined,
    },
  },
}));

type Props = SocialBlockSchema;

export function SocialBlock({ url, type }: Props) {
  const { classes } = useStyles({ type });
  const content = useMemo(() => {
    if (type === 'ig-reel') return <InstagramReel url={url} />;
    if (type === 'ig-post') return <InstagramPost url={url} />;
    if (type === 'yt-short') return <YoutubeShort url={url} />;
    if (type === 'yt-long') return <Youtube url={url} />;
    if (type === 'tw-post') return <Tweet url={url} />;
    return null;
  }, [type]);

  return <div className={classes.card}>{content}</div>;
}

function InstagramReel({ url }: { url: string }) {
  return <InstagramEmbed url={url} width="100%" placeholderDisabled />;
}

function InstagramPost({ url }: { url: string }) {
  return <InstagramEmbed url={url} width="100%" placeholderDisabled />;
}

function extractVideoID(url: string) {
  // Regular expression to find the YouTube video ID
  const regExp =
    /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?)|(shorts\/))\??v?=?([^#&?]*).*/;
  const match = url.match(regExp);

  return match && match[8].length == 11 ? match[8] : null;
}

function YoutubeShort({ url }: { url: string }) {
  url = url.includes('/shorts/') ? url.replace('/shorts/', '/watch?v=') : url;
  const videoId = extractVideoID(url);
  console.log({ videoId });
  return (
    <YouTubeEmbed
      url={url}
      width="100%"
      placeholderDisabled
      height={typeHeight['yt-short']}
      youTubeProps={{
        opts: {
          playerVars: {
            // autoplay: 1,
            loop: 1,
            showinfo: 0,
            // playlist: videoId,
          },
        },
      }}
    />
  );
}

function Youtube({ url }: { url: string }) {
  return <YouTubeEmbed url={url} width="100%" placeholderDisabled height={typeHeight['yt-long']} />;
}

function Tweet({ url }: { url: string }) {
  return <TwitterEmbed url={url} width="100%" placeholderDisabled />;
}
