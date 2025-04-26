import { Box, Button, Text, Title } from '@mantine/core';
import { Badge } from './Assets/Badge';
import { Logo } from './Assets/Logo';
import { containerQuery } from '~/utils/mantine-css-helpers';
import styles from './MediaKit.module.scss';

export function MediaKit() {
  return (
    <>
      <Box className={styles.kit}>
        <Box className={styles.description}>
          <Title order={3}>Civitai Logo</Title>
          <Text>A collection of our Civitai logos in various brand colors.</Text>
          <Button
            component="a"
            className={styles.descriptionButton}
            download
            href="https://publicstore.civitai.com/media-kits/civitai-logo-kit.zip"
            variant="outline"
          >
            Download logo kit
          </Button>
        </Box>
        <Box className={styles.media}>
          <Box className={styles.mediaRow} style={{ gridTemplateColumns: '3fr 1fr' }}>
            <Box
              bg="white"
              style={{
                border: '1px solid var(--mantine-color-gray-2)',
              }}
            >
              <Logo baseColor="#222" />
            </Box>
            <Box
              bg="white"
              style={{
                border: '1px solid var(--mantine-color-gray-2)',
              }}
            >
              <Badge />
            </Box>
          </Box>
          <Box className={styles.mediaRow} style={{ gridTemplateColumns: '1fr 3fr' }}>
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
      <Box className={styles.kit}>
        <Box className={styles.description}>
          <Title order={3}>Media Gallery</Title>
          <Text>
            A collection of screenshots of some of the most important features of our product
          </Text>
          <Button
            component="a"
            className={styles.descriptionButton}
            download
            href="https://publicstore.civitai.com/media-kits/civitai-media-kit.zip"
            variant="outline"
          >
            Download media kit
          </Button>
        </Box>
        <Box className={styles.media}>
          <img src="/images/media/cover.png" alt="The Civitai platform" />
        </Box>
      </Box>
    </>
  );
}

