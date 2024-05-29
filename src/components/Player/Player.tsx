import {
  ActionIcon,
  Badge,
  CloseButton,
  Group,
  Paper,
  Portal,
  Slider,
  Stack,
  Text,
  Transition,
  createStyles,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconVolume, IconVolumeOff } from '@tabler/icons-react';
import { createContext, useCallback, useContext, useState } from 'react';
import { EdgeAudio } from '~/components/EdgeMedia/EdgeAudio';
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

type Track = {
  media: HTMLMediaElement;
  peaks: number[][];
  duration: number;
  name?: string | null;
};

type UniversalPlayerState = {
  currentTrack: Track | null;
  setCurrentTrack: React.Dispatch<React.SetStateAction<Track | null>>;
};

const UniversalPlayerContext = createContext<UniversalPlayerState>({
  currentTrack: null,
  setCurrentTrack: () => null,
});

export const useUniversalPlayerContext = () => {
  return useContext(UniversalPlayerContext);
};

export function UniversalPlayerProvider({ children }: { children: React.ReactNode }) {
  const { classes } = useStyles();

  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);

  const handleClose = useCallback(() => {
    setCurrentTrack(null);
  }, [setCurrentTrack]);

  return (
    <UniversalPlayerContext.Provider value={{ currentTrack, setCurrentTrack }}>
      {children}
      <Transition mounted={!!currentTrack} transition="scale-y">
        {(style) => (
          <Portal target="main">
            <div className={classes.wrapper} style={style}>
              <Paper className={classes.player} p="sm" shadow="md">
                <Group position="apart" noWrap>
                  <Stack spacing={4} style={{ flexGrow: 1 }}>
                    {currentTrack?.name && (
                      <Group spacing={8} position="apart" noWrap>
                        <Text size="sm" color="white" weight="bold" lineClamp={1}>
                          {currentTrack.name}
                        </Text>
                        <Group spacing={8} noWrap>
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
                          <VolumeControl />
                        </Group>
                      </Group>
                    )}
                    <EdgeAudio
                      {...currentTrack}
                      wrapperProps={{ sx: { flexDirection: 'row-reverse' } }}
                      interact
                      dragToSeek
                    />
                  </Stack>
                  <CloseButton size="sm" onClick={handleClose} aria-label="close player" />
                </Group>
              </Paper>
            </div>
          </Portal>
        )}
      </Transition>
    </UniversalPlayerContext.Provider>
  );
}

function VolumeControl() {
  const [volume, setVolume] = useLocalStorage({ key: 'player-volume', defaultValue: 1 });
  const [endVolume, setEndVolume] = useState(volume);
  const { currentTrack } = useUniversalPlayerContext();

  const handleSetVolume = (value: number) => {
    if (!currentTrack) return;

    setVolume(value);
    currentTrack.media.volume = value;
  };

  return (
    <Group spacing={4} noWrap>
      <ActionIcon
        radius="xl"
        size="xs"
        variant="subtle"
        onClick={() => handleSetVolume(volume === 0 ? endVolume : 0)}
      >
        {volume > 0 ? <IconVolume /> : <IconVolumeOff />}
      </ActionIcon>
      <Slider
        size="xs"
        radius="xl"
        step={1}
        value={Math.floor(volume * 100)}
        onChange={(v) => handleSetVolume(v / 100)}
        onChangeEnd={(v) => setEndVolume(v / 100)}
        style={{ width: 60 }}
      />
    </Group>
  );
}
