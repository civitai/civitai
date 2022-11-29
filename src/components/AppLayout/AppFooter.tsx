import { Button, ButtonProps, createStyles, Footer, Group, Text } from '@mantine/core';
import { useDebouncedState, useWindowEvent } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import { useIsMobile } from '~/hooks/useIsMobile';

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

export function AppFooter() {
  const { classes, cx } = useStyles();
  const [showFooter, setShowFooter] = useDebouncedState(true, 200);
  const mobile = useIsMobile();

  useWindowEvent('scroll', () => {
    const scroll = getScrollPosition();
    setShowFooter(scroll.y < 10);
  });

  return (
    <Footer className={cx(classes.root, { [classes.down]: !showFooter })} height="auto" p="sm">
      <Group spacing={mobile ? 'sm' : 'lg'} sx={{ flexWrap: 'nowrap' }}>
        <Text weight={700} sx={{ whiteSpace: 'nowrap' }}>
          &copy; Civitai {new Date().getFullYear()}
        </Text>
        <Group spacing={0} sx={{ flexWrap: 'nowrap' }}>
          <Button component={NextLink} href="/content/tos" {...buttonProps} px={mobile ? 5 : 'xs'}>
            Terms of Service
          </Button>
          <Button
            component="a"
            href="https://github.com/civitai/civitai"
            {...buttonProps}
            target="_blank"
          >
            GitHub
          </Button>
          <Button
            component="a"
            href="https://discord.gg/UwX5wKwm6c"
            {...buttonProps}
            target="_blank"
          >
            Discord
          </Button>
          <Button
            component="a"
            href="https://twitter.com/HelloCivitai"
            {...buttonProps}
            target="_blank"
          >
            Twitter
          </Button>
          <Button
            component="a"
            href="https://github.com/civitai/civitai/wiki/REST-API-Reference"
            {...buttonProps}
            target="_blank"
          >
            API
          </Button>
        </Group>
        <Button
          component="a"
          href="https://github.com/civitai/civitai/discussions/categories/ideas"
          ml="auto"
          variant="light"
          color="yellow"
          target="_blank"
        >
          💡 Ideas!
        </Button>
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
