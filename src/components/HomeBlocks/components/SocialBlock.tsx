import { Box } from '@mantine/core';
import { useId } from '@mantine/hooks';
import { IconPlayerPlayFilled } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { InstagramEmbed, XEmbed, YouTubeEmbed } from 'react-social-media-embed';
import classes from './SocialBlock.module.scss';
import clsx from 'clsx';
import { camelCase } from 'lodash-es';

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
  const SocialComponent = socialBlockComponent[type];
  const socialClass = camelCase(type) as keyof typeof classes;

  return (
    <div className={clsx(classes.card, classes[socialClass])}>
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
      script.onload;
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
    const interval = window.setInterval(() => {
      if (!window.Twitch) return;
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
      window.clearInterval(interval);
    }, 100);
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

function Youtube({ url }: { url: string }) {
  const videoId = extractVideoID(url);
  const [initialized, setInitialized] = useState(false);
  if (!initialized) {
    return (
      <div onClick={() => setInitialized(true)} className={classes.videoPlayholderRoot}>
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
