import { Box, Button, createStyles, Text, Title } from '@mantine/core';
import { Badge } from './Assets/Badge';
import { Logo } from './Assets/Logo';
import { containerQuery } from '~/utils/mantine-css-helpers';

export function MediaKit() {
  const { classes, theme } = useStyle();
  return (
    <>
      <Box className={classes.kit}>
        <Box className={classes.description}>
          <Title order={3} className={classes.descriptionTitle}>
            Civitai Logo
          </Title>
          <Text className={classes.descriptionText}>
            A collection of our Civitai logos in various brand colors.
          </Text>
          <Button
            component="a"
            className={classes.descriptionButton}
            download
            href="https://publicstore.civitai.com/media-kits/civitai-logo-kit.zip"
            variant="outline"
          >
            Download logo kit
          </Button>
        </Box>
        <Box className={classes.media}>
          <Box className={classes.mediaRow} style={{ gridTemplateColumns: '3fr 1fr' }}>
            <Box
              bg="white"
              style={{
                border:
                  theme.colorScheme === 'light' ? `1px solid ${theme.colors.gray[2]}` : undefined,
              }}
            >
              <Logo baseColor="#222" />
            </Box>
            <Box
              bg="white"
              style={{
                border:
                  theme.colorScheme === 'light' ? `1px solid ${theme.colors.gray[2]}` : undefined,
              }}
            >
              <Badge />
            </Box>
          </Box>
          <Box className={classes.mediaRow} style={{ gridTemplateColumns: '1fr 3fr' }}>
            <Box bg="blue.9">
              <Badge
                innerGradient={['transparent', 'transparent']}
                outerGradient={['#fff', '#fff']}
              />
            </Box>
            <Box bg="dark">
              <Logo />
            </Box>
          </Box>
        </Box>
      </Box>
      <Box className={classes.kit}>
        <Box className={classes.description}>
          <Title order={3} className={classes.descriptionTitle}>
            Media Gallery
          </Title>
          <Text className={classes.descriptionText}>
            A collection of screenshots of some of the most important features of our product
          </Text>
          <Button
            component="a"
            className={classes.descriptionButton}
            download
            href="https://publicstore.civitai.com/media-kits/civitai-media-kit.zip"
            variant="outline"
          >
            Download media kit
          </Button>
        </Box>
        <Box className={classes.media}>
          <img src="/images/media/cover.png" alt="The Civitai platform" />
        </Box>
      </Box>
    </>
  );
}

const useStyle = createStyles((theme) => ({
  kit: {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: theme.spacing.xl,
    [containerQuery.largerThan('md')]: {
      gridTemplateColumns: '1fr 2fr',
    },
    ['&+&']: {
      marginTop: theme.spacing.xl * 2,
    },
  },
  description: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing.md,
    alignItems: 'flex-start',
  },
  descriptionTitle: {},
  descriptionText: {},
  descriptionButton: {
    marginTop: theme.spacing.md,
  },
  media: {
    display: 'grid',
    gap: theme.spacing.sm,

    img: {
      maxWidth: '100%',
    },
  },
  mediaRow: {
    width: '100%',
    display: 'grid',
    gap: theme.spacing.sm,
    div: {
      height: '7rem',
      borderRadius: theme.radius.sm,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: theme.spacing.sm,

      [containerQuery.largerThan('md')]: {
        height: '10rem',
        padding: theme.spacing.lg,
      },

      svg: {
        width: '100%',
        height: '100%',
        maxHeight: 60,
      },
    },
  },
}));
