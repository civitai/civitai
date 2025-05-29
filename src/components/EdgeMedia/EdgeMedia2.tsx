import { useState } from 'react';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { MAX_ANIMATION_DURATION_SECONDS } from '~/server/common/constants';
import type { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';

type SharedMediaProps = {
  width?: number;
  height?: number;
  anim?: boolean;
  quality?: number;
  gamma?: number;
  transcode?: boolean;
  optimized?: boolean;
  name?: string | null;
  withControls?: boolean;
  url: string;
};

type ImageMediaProps = { type: 'image'; metadata?: ImageMetadata } & SharedMediaProps;
type VideoMediaProps = { type: 'video'; metadata?: VideoMetadata } & SharedMediaProps;

type EdgeMediaProps = ImageMediaProps | VideoMediaProps;

function EdgeMedia2(props: EdgeMediaProps) {
  if (props.name && videoTypeExtensions.some((ext) => props.name?.endsWith(ext)))
    props.type = 'video';

  if (props.width && props.metadata) props.width = Math.min(props.width, props.metadata.width); // original: true ???
  if (props.height && props.metadata) props.height = Math.min(props.height, props.metadata.height);

  switch (props.type) {
    case 'image':
      return <EdgeImage {...props} />;
    case 'video':
      return <EdgeVideo {...props} />;
    default:
      return <span className="flex justify-center">Unsupported media type</span>;
  }
}

function EdgeImage(props: ImageMediaProps) {
  // eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element
  return <img />;
}

function EdgeVideo(props: VideoMediaProps) {
  const [loaded, setLoaded] = useState(false);

  const autoplayGifs = useBrowsingSettings((x) => x.autoplayGifs);
  const duration = props.metadata?.duration ?? 0;
  if (props.anim === undefined) {
    if (!autoplayGifs) props.anim = false;
    else if (duration > 0 && duration <= MAX_ANIMATION_DURATION_SECONDS) props.anim = true;
  }

  const skip = duration > MAX_ANIMATION_DURATION_SECONDS ? 4 : undefined;
  const withControls = props.withControls && duration > MAX_ANIMATION_DURATION_SECONDS;

  return (
    <div
      className="relative"
      style={{ aspectRatio: props.metadata ? props.metadata.width / props.metadata.height : 1 }}
    >
      <video src=""></video>
    </div>
  );
}

const videoTypeExtensions = ['.gif', '.mp4', '.webm'];

/*
  TODO - mute controls should live in video component. Use a zustand global store with localstorage
*/
