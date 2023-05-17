import {
  Anchor,
  Button,
  ButtonProps,
  Code,
  createStyles,
  Footer,
  Group,
  Stack,
  Text,
} from '@mantine/core';
import { useDebouncedState, useWindowEvent } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import { useState } from 'react';
import { env } from '~/env/client.mjs';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

interface ScrollPosition {
  x: number;
  y: number;
}

function getScrollPosition(): ScrollPosition {
  return typeof window !== 'undefined'
    ? { x: window.pageXOffset, y: window.pageYOffset }
    : { x: 0, y: 0 };
}

const buttonProps: ButtonProps = {
  size: 'xs',
  variant: 'subtle',
  color: 'gray',
};

const hash = env.NEXT_PUBLIC_GIT_HASH;

export function AppFooter() {
  const { classes, cx } = useStyles();
  const [showHash, setShowHash] = useState(false);
  const [showFooter, setShowFooter] = useDebouncedState(true, 200);
  const mobile = useIsMobile();
  const features = useFeatureFlags();

  useWindowEvent('scroll', () => {
    const scroll = getScrollPosition();
    setShowFooter(scroll.y < 10);
  });

  return (
    <Footer className={cx(classes.root, { [classes.down]: !showFooter })} height="auto" p="sm">
      <Group spacing={mobile ? 'sm' : 'lg'} sx={{ flexWrap: 'nowrap' }}>
        <Text
          weight={700}
          sx={{ whiteSpace: 'nowrap', userSelect: 'none' }}
          onDoubleClick={() => {
            if (hash) setShowHash((x) => !x);
          }}
        >
          &copy; Civitai {new Date().getFullYear()}
        </Text>
        {showHash && hash && (
          <Stack spacing={2}>
            <Text weight={500} size="xs" sx={{ lineHeight: 1.1 }}>
              Site Version
            </Text>
            <Anchor
              target="_blank"
              href={`/github/commit/${hash}`}
              w="100%"
              sx={{ '&:hover': { textDecoration: 'none' } }}
            >
              <Code sx={{ textAlign: 'center', lineHeight: 1.1, display: 'block' }}>
                {hash.substring(0, 7)}
              </Code>
            </Anchor>
          </Stack>
        )}
        <Group spacing={0} sx={{ flexWrap: 'nowrap' }}>
          <Button
            component={NextLink}
            href="/pricing"
            {...buttonProps}
            variant="subtle"
            color="pink"
            px={mobile ? 5 : 'xs'}
          >
            Support Us ❤️
          </Button>
          <Button
            component={NextLink}
            prefetch={false}
            href="/content/tos"
            {...buttonProps}
            px={mobile ? 5 : 'xs'}
          >
            Terms of Service
          </Button>
          <Button
            component={NextLink}
            prefetch={false}
            href="/content/privacy"
            {...buttonProps}
            px={mobile ? 5 : 'xs'}
          >
            Privacy
          </Button>
          <Button component="a" href="/github" {...buttonProps} target="_blank">
            GitHub
          </Button>
          <Button component="a" href="/discord" {...buttonProps} target="_blank">
            Discord
          </Button>
          <Button component="a" href="/twitter" {...buttonProps} target="_blank">
            Twitter
          </Button>
          <Button component="a" href="/reddit" {...buttonProps} target="_blank">
            Reddit
          </Button>
          <Button
            component="a"
            href="/github/wiki/REST-API-Reference"
            {...buttonProps}
            target="_blank"
          >
            API
          </Button>
          <Button component="a" href="https://status.civitai.com" {...buttonProps} target="_blank">
            Status
          </Button>
        </Group>
        <Group ml="auto" spacing={4} sx={{ flexWrap: 'nowrap' }}>
          <Button component="a" href="/canny/bugs" {...buttonProps} target="_blank" pl={4} pr="xs">
            🪲 Bugs
          </Button>
          <Button
            component="a"
            href="/canny/feedback"
            variant="light"
            color="yellow"
            target="_blank"
            pl={4}
            pr="xs"
          >
            💡 Ideas
          </Button>
          {/* <Button component={NextLink} href="/feedback" ml="auto" variant="light" color="yellow">
          💡 Ideas!
        </Button> */}
        </Group>
      </Group>
    </Footer>
  );
}

const useStyles = createStyles((theme) => ({
  root: {
    position: 'fixed',
    bottom: 0,
    right: 0,
    left: 0,
    borderTop: `1px solid ${
      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
    }`,
    // boxShadow: '0 -1px 3px rgba(0, 0, 0, 0.05), 0 -1px 2px rgba(0, 0, 0, 0.1)',
    transitionProperty: 'transform',
    transitionDuration: '0.3s',
    transitionTimingFunction: 'linear',
    overflowX: 'auto',
    // transform: 'translateY(0)',
  },
  down: {
    transform: 'translateY(200%)',
    // bottom: '-60',
  },
}));
