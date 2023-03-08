import { Box, BoxProps } from '@mantine/core';

export const YoutubeEmbed = ({ videoId, sx, ...props }: { videoId: string } & BoxProps) => (
  <Box
    {...props}
    sx={{
      overflow: 'hidden',
      position: 'relative',
      height: 0,
      paddingBottom: '56.25%',
      iframe: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
      },
    }}
  >
    <iframe
      width="853"
      height="480"
      src={`https://www.youtube.com/embed/${videoId}`}
      frameBorder="0"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
      title="Embedded youtube"
    />
  </Box>
);
