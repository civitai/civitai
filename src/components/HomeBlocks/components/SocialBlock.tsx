import { Box, createStyles } from '@mantine/core';
import { useId } from '@mantine/hooks';
import { useEffect, useMemo, useState } from 'react';
import { InstagramEmbed, TwitterEmbed, YouTubeEmbed } from 'react-social-media-embed';

export type SocialBlockProps = {
  url: string;
  type: 'ig-reel' | 'ig-post' | 'yt-short' | 'yt-long' | 'tw-post' | 'twitch';
};

const typeHeight: Partial<Record<SocialBlockProps['type'], number>> = {
  'ig-reel': 505,
  'ig-post': 505,
  'yt-short': 569,
  'yt-long': 369,
  twitch: 369,
};

const useStyles = createStyles((theme, { type }: { type: SocialBlockProps['type'] }) => ({
  card: {
    borderRadius: theme.radius.md,
    overflow: 'hidden',
    height: typeHeight[type],
    background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    iframe: {
      border: 'none !important',
    },
    [theme.fn.largerThan('sm')]: {
      gridColumn: ['yt-long', 'twitch'].includes(type) ? 'span 2' : undefined,
    },
  },
}));

export function SocialBlock({ url, type }: SocialBlockProps) {
  const { classes } = useStyles({ type });
  const content = useMemo(() => {
    if (type === 'ig-reel') return <InstagramReel url={url} />;
    if (type === 'ig-post') return <InstagramPost url={url} />;
    if (type === 'yt-short') return <YoutubeShort url={url} />;
    if (type === 'yt-long') return <Youtube url={url} />;
    if (type === 'tw-post') return <Tweet url={url} />;
    if (type === 'twitch') return <TwitchStream channel={url} />;
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

let twitchStarted = false;
function useTwitchEmbed() {
  const [ready, setReady] = useState(twitchStarted);
  useEffect(() => {
    if (!twitchStarted) {
      console.log('loading twitch embed');
      const script = document.createElement('script');
      script.src = 'https://embed.twitch.tv/embed/v1.js';
      document.body.appendChild(script);
      script.onload = () => {
        setReady(true);
      };
      twitchStarted = true;
    }
  }, []);

  return { ready };
}
function TwitchStream({ channel }: { channel: string }) {
  const { ready } = useTwitchEmbed();
  const [initialized, setInitialized] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!ready || initialized) return;
    new window.Twitch.Embed(id, {
      width: '100%',
      height: '100%',
      channel,
      layout: 'video',
      allowfullscreen: true,
      muted: true,
      parent: ['civitai.com'],
    });
    setInitialized(true);
  }, [ready, id, channel]);

  return <Box id={id} w="100%" h="100%" />;
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
