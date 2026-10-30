import { Button, Container, Group, Paper, Stack, Text } from '@mantine/core';
import type { GetServerSideProps } from 'next';
import {
  ExternalLinkWarningBody,
  ExternalLinkWarningTitle,
} from '~/components/ExternalLinkWarning/ExternalLinkWarning';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { parseExternalDestination } from '~/utils/external-link';

type Props = { destination: string | null };

export const getServerSideProps: GetServerSideProps<Props> = async ({ query }) => ({
  props: { destination: parseExternalDestination(query.url) },
});

/**
 * 🔴 Never redirect from here — no server redirect, no meta refresh, no script navigation. The
 * destination is whatever the query string says, so a page that forwarded to it would be an open
 * redirect on Civitai's domain. The only way onward is the reader clicking the link.
 */
export default function LeavingCivitaiPage({ destination }: Props) {
  return (
    <>
      <Meta title="Leaving Civitai" deIndex />
      <Container size="xs" className="py-8">
        <Paper withBorder p="lg">
          <Stack gap="md">
            <ExternalLinkWarningTitle />
            {destination ? (
              <ExternalLinkWarningBody href={destination} />
            ) : (
              <Text size="sm">This link is missing its destination or is not a web address.</Text>
            )}
            <Group justify="flex-end" gap="sm">
              <Button component={Link} href="/" variant="default">
                Back to Civitai
              </Button>
              {destination && (
                <Button component="a" href={destination} rel="nofollow noopener noreferrer">
                  Continue
                </Button>
              )}
            </Group>
          </Stack>
        </Paper>
      </Container>
    </>
  );
}
