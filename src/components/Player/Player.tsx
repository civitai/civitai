import {
  Badge,
  CloseButton,
  Group,
  Paper,
  Portal,
  Stack,
  Text,
  Transition,
  createStyles,
} from '@mantine/core';
import { useCallback, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { EdgeAudio } from '~/components/EdgeMedia/EdgeAudio';
import { usePlayerStore } from '~/store/player.store';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { formatDuration } from '~/utils/number-helpers';

const useStyles = createStyles(() => ({
  wrapper: {
    zIndex: 99999,
    position: 'relative',
  },

  player: {
    position: 'absolute',
    maxWidth: 480,
    bottom: 0,
    width: '100%',
    left: '50%',
    transform: 'translateX(-50%)',
    backgroundColor: 'rgba(73, 73, 73, .25)',
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderBottomRightRadius: 0,
    borderBottomLeftRadius: 0,
    backdropFilter: 'blur(5px)',

    [containerQuery.largerThan('sm')]: {
      borderRadius: 12,
      bottom: 24,
    },
  },
}));

export function UniversalPlayerProvider() {
  const { currentTrack, pause, setCurrentTrack } = usePlayerStore();
  const { classes } = useStyles();

  // if (!currentTrack) return null;

  const handleClose = useCallback(() => {
    pause();
    setCurrentTrack(null);
  }, [pause, setCurrentTrack]);

  return (
    <Transition mounted={!!currentTrack} transition="scale-y">
      {(style) => (
        <Portal target="main">
          <div className={classes.wrapper} style={style}>
            <Paper className={classes.player} p="sm" shadow="md" withBorder>
              <Group position="apart" noWrap>
                <Stack spacing={4} style={{ flexGrow: 1 }}>
                  {currentTrack?.name && (
                    <Group spacing={8} position="apart" noWrap>
                      <Text size="sm" color="white" weight="bold" lineClamp={1}>
                        {currentTrack.name}
                      </Text>
                      {currentTrack?.duration && (
                        <Badge
                          size="md"
                          color="gray.8"
                          variant="filled"
                          radius="sm"
                          px={4}
                          py={2}
                          style={{ flexShrink: 0, boxShadow: '1px 2px 3px -1px #25262B33' }}
                        >
                          <Text weight="bold" color="white" inherit>
                            {formatDuration(currentTrack.duration)}
                          </Text>
                        </Badge>
                      )}
                    </Group>
                  )}
                  <EdgeAudio
                    media={currentTrack?.media}
                    peaks={currentTrack?.peaks}
                    duration={currentTrack?.duration}
                    name={currentTrack?.name}
                    wrapperProps={{ sx: { flexDirection: 'row-reverse' } }}
                  />
                </Stack>
                <CloseButton size="sm" onClick={handleClose} aria-label="close player" />
              </Group>
            </Paper>
          </div>
        </Portal>
      )}
    </Transition>
  );
}
