import { Button, Flex, Text, Anchor } from '@mantine/core';
import { CIVITAI_LINK_DESKTOP_RELEASES } from '~/components/CivitaiLink/civitai-link-paths';
import { NextLink as Link } from '~/components/NextLink/NextLink';

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
  return (
    <Flex direction="column" justify="space-between" align="center">
      <Button
        variant="filled"
        color="blue"
        size="lg"
        radius="xl"
        component={Link}
        href={href}
        rel="nofollow noreferrer"
      >
        <Flex direction="column" justify="space-between" align="center">
          {text}
          {isMember ? <Text fz={10}>{secondaryText}</Text> : null}
        </Flex>
      </Button>
      {isMember ? (
        <Text fz={10} mt={10}>
          Not your OS? Check out all{' '}
          <Anchor inherit href={CIVITAI_LINK_DESKTOP_RELEASES} target="_blank">
            releases
          </Anchor>
          .
        </Text>
      ) : null}
    </Flex>
  );
}
