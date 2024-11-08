import { Button, Flex, Text, Anchor, createStyles } from '@mantine/core';
import { NextLink } from '@mantine/next';

type LinkDownloadButtonProps = {
  text: string;
  secondaryText: string;
  href: string;
  isMember?: boolean;
};

export function CivitaiLinkDownloadButton({
  text,
  secondaryText,
  href,
  isMember,
}: LinkDownloadButtonProps) {
  const { classes } = useStyles();

  return (
    <Flex direction="column" justify="space-between" align="center">
      <Button
        variant="filled"
        color="blue"
        size="lg"
        radius="xl"
        component={NextLink}
        href={href}
        rel="nofollow noreferrer"
      >
        <Flex direction="column" justify="space-between" align="center">
          {text}
          {isMember ? <Text className={classes.buttonSecondary}>{secondaryText}</Text> : null}
        </Flex>
      </Button>
      {isMember ? (
        <Text className={classes.buttonSecondary} mt={10}>
          Not your OS? Check out all{' '}
          <Anchor
            href="https://github.com/civitai/civitai-link-desktop/releases/latest"
            target="_blank"
          >
            releases
          </Anchor>
          .
        </Text>
      ) : null}
    </Flex>
  );
}

const useStyles = createStyles(() => ({
  buttonSecondary: {
    fontSize: 10,
  },
}));
