import { createStyles, Footer, Group, Text } from '@mantine/core';
import { useDebouncedState, useWindowEvent } from '@mantine/hooks';
import { NextLink } from '@mantine/next';

interface ScrollPosition {
  x: number;
  y: number;
}

function getScrollPosition(): ScrollPosition {
  return typeof window !== 'undefined'
    ? { x: window.pageXOffset, y: window.pageYOffset }
    : { x: 0, y: 0 };
}

export function AppFooter() {
  const { classes, cx } = useStyles();
  const [showFooter, setShowFooter] = useDebouncedState(true, 200);

  useWindowEvent('scroll', () => {
    const scroll = getScrollPosition();
    setShowFooter(scroll.y < 10);
  });

  return (
    <Footer className={cx(classes.root, { [classes.down]: !showFooter })} height="auto" p="sm">
      <Group spacing="lg">
        <Text mr="md" weight={700}>
          &copy; Civitai {new Date().getFullYear()}
        </Text>
        <Group spacing="lg">
          <Text component={NextLink} href="/content/tos" size="sm">
            Terms of Service
          </Text>
          <Text component="a" href="https://github.com/civitai/civitai" size="sm">
            GitHub
          </Text>
          <Text component="a" href="https://discord.gg/UwX5wKwm6c" size="sm">
            Discord
          </Text>
          <Text component="a" href="https://twitter.com/HelloCivitai" size="sm">
            Twitter
          </Text>
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
    // transform: 'translateY(0)',
  },
  down: {
    transform: 'translateY(200%)',
    // bottom: '-60',
  },
}));
