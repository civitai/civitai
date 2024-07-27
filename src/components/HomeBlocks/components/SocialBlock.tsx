import { Box, createStyles } from '@mantine/core';
import { useId } from '@mantine/hooks';
import { IconPlayerPlayFilled } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { InstagramEmbed, XEmbed, YouTubeEmbed } from 'react-social-media-embed';
import { containerQuery } from '~/utils/mantine-css-helpers';

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
    [containerQuery.largerThan('sm')]: {
      gridColumn: ['yt-long', 'twitch'].includes(type) ? 'span 2' : undefined,
    },
  },
}));

const socialBlockComponent: Record<
  SocialBlockProps['type'],
  (props: { url: string }) => JSX.Element
> = {
  'ig-reel': InstagramReel,
  'ig-post': InstagramPost,
  'yt-short': YoutubeShort,
  'yt-long': Youtube,
  'tw-post': Tweet,
  twitch: TwitchStream,
};

export function SocialBlock({ url, type }: SocialBlockProps) {
  const { classes } = useStyles({ type });
  const SocialComponent = socialBlockComponent[type];

  return (
    <div className={classes.card}>
      <SocialComponent url={url} />
    </div>
  );
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
function TwitchStream({ url }: { url: string }) {
  const { ready } = useTwitchEmbed();
  const [initialized, setInitialized] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!ready || initialized) return;
    new window.Twitch.Embed(id, {
      width: '100%',
      height: '100%',
      channel: url,
      layout: 'video',
      allowfullscreen: true,
      muted: true,
      parent: ['civitai.com'],
    });
    setInitialized(true);
  }, [ready, id, url, initialized]);

  return (
    // HACK: Needed to prevent the Twitch embed from being removed from the DOM. See: https://stackoverflow.com/questions/54880669/react-domexception-failed-to-execute-removechild-on-node-the-node-to-be-re
    <div style={{ height: '100%' }}>
      <Box id={id} w="100%" h="100%" />
    </div>
  );
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
  // const videoId = extractVideoID(url);
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
            // playlist: videoId,
          },
        },
      }}
    />
  );
}

const useVideoPlayholderStyle = createStyles((theme, _, getRef) => {
  const ref = getRef('playButton');
  return {
    root: {
      height: '100%',
      position: 'relative',
      cursor: 'pointer',
      [`& .${ref}`]: {
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
      },
      '&:hover': {
        [`& .${ref}`]: {
          backgroundColor: 'rgba(0,0,0,1)',
        },
      },
      img: {
        objectFit: 'contain',
        height: '100%',
        objectPosition: '50% 50%',
      },
    },
    playButton: {
      ref,
      width: 80,
      height: 80,
      color: theme.white,
      backgroundColor: 'rgba(0,0,0,.9)',
      padding: 20,
      borderRadius: '50%',
      boxShadow: `0 5px 3px 2px rgba(0,0,0,1), inset 0 0 0 1px rgba(255,255,255,.2)`,
      transition: 'background-color 200ms ease',
    },
  };
});

function Youtube({ url }: { url: string }) {
  const videoId = extractVideoID(url);
  const { classes } = useVideoPlayholderStyle();
  const [initialized, setInitialized] = useState(false);
  if (!initialized) {
    return (
      <div onClick={() => setInitialized(true)} className={classes.root}>
        <IconPlayerPlayFilled className={classes.playButton} />
        <img src={`https://i3.ytimg.com/vi/${videoId}/maxresdefault.jpg`} />
      </div>
    );
  }
  return (
    <YouTubeEmbed
      url={url}
      width="100%"
      placeholderDisabled
      height={typeHeight['yt-long']}
      youTubeProps={{
        opts: {
          playerVars: {
            autoplay: 1,
          },
        },
      }}
    />
  );
}

function Tweet({ url }: { url: string }) {
  return <XEmbed url={url} width="100%" placeholderDisabled />;
}
