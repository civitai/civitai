import { Anchor, Center, List, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import Link from 'next/link';
import type { SearchRefusal } from '~/components/Search/search-refusal';

/** What a refused search shows in place of results, on the search pages and on a searched feed. */
export function SearchRefusalNotice({
  refusal,
  profanityMatches = [],
}: {
  refusal: SearchRefusal;
  profanityMatches?: string[];
}) {
  if (refusal === 'illegal')
    return (
      <Center>
        <Stack maw={750} align="center" justify="center" className="h-full">
          <Stack align="center" gap={0}>
            <IconAlertTriangle size={42} color="red" />
            <Text weight={700} size="xl" c="red">
              Warning
            </Text>
          </Stack>
          <Text align="center">
            Your search may be for{' '}
            <Text span weight={700} c="red">
              illegal and abusive sexual material involving minors
            </Text>
            .
          </Text>
          <Text align="center">
            Viewing, sharing, or creating such content is a{' '}
            <Text span weight={700}>
              serious crime
            </Text>
            . If you feel worried about your sexual thoughts about anyone under 18,{' '}
            <Text span weight={700}>
              free, confidential, and anonymous help is available
            </Text>
            :
          </Text>
          <List spacing="xs" size="md" center>
            <List.Item>
              <Text span weight={700}>
                Phone (UK)
              </Text>{' '}
              Stop It Now! helpline —{' '}
              <Text span weight={700}>
                0808 1000 900
              </Text>
              <br />
              <Text size="xs" c="dimmed">
                (no caller ID saved)
              </Text>
            </List.Item>
            <List.Item>
              <Text span weight={700}>
                Online Support (global)
              </Text>{' '}
              <Anchor
                href="https://www.stopitnow.org.uk/self-help/concerned-about-your-own-thoughts-or-behaviour/?utm_source=civitai&utm_medium=warning_message&utm_campaign=civitai_warning"
                target="_blank"
                rel="noopener noreferrer"
              >
                Get Help
              </Anchor>{' '}
              – self-help tools, live chat, and secure email
            </List.Item>
          </List>
          <Text align="center" c="dimmed" size="sm" mt="md">
            We strictly enforce our{' '}
            <Anchor href="/content/tos#content-policies" target="_blank">
              Terms of Service
            </Anchor>
            . Abuse will be reported and may lead to criminal investigation. Visit our{' '}
            <Anchor href="/safety" target="_blank">
              Safety Center
            </Anchor>{' '}
            for more information.
          </Text>
          <Anchor component={Link} href="/" mt="md">
            <Text size="md">Go Back ↩︎</Text>
          </Anchor>
        </Stack>
      </Center>
    );

  if (refusal === 'profanity')
    return (
      <Center>
        <Stack maw={750} align="center" justify="center" className="h-full">
          <Stack align="center" gap={0}>
            <IconAlertTriangle size={42} color="orange" />
            <Text weight={700} size="xl" c="orange">
              Content Policy Violation
            </Text>
          </Stack>
          <Text align="center">
            Your search contains{' '}
            <Text span weight={700} c="orange">
              inappropriate content
            </Text>{' '}
            that violates our community guidelines.
          </Text>
          {profanityMatches.length > 0 && (
            <Text align="center" c="dimmed" size="sm">
              Flagged terms: {profanityMatches.join(', ')}
            </Text>
          )}
          <Text align="center">
            Our family-friendly environment requires all searches to comply with our{' '}
            <Text span weight={700}>
              content policies
            </Text>
            . Please refine your search terms to find appropriate content.
          </Text>
          <Text align="center" c="dimmed" size="sm" mt="md">
            We maintain strict{' '}
            <Anchor href="/content/tos#content-policies" target="_blank">
              community standards
            </Anchor>{' '}
            to ensure a safe environment for all users. Visit our{' '}
            <Anchor href="/safety" target="_blank">
              Safety Center
            </Anchor>{' '}
            for more information about our policies.
          </Text>
          <Stack mt="lg" align="center" gap={4}>
            <Anchor component={Link} href="/" variant="subtle">
              <Text size="md">Go Home ↩︎</Text>
            </Anchor>
            <Text c="dimmed" size="sm">
              or modify your search above
            </Text>
          </Stack>
        </Stack>
      </Center>
    );

  return (
    <Center>
      <Stack maw={750} align="center" gap="xs" className="h-full py-8">
        <IconAlertTriangle size={42} color="orange" />
        <Text align="center">
          {refusal === 'poi'
            ? 'Your search includes terms tied to real people. Content depicting real people is filtered from search results.'
            : 'Your search query contains blocked words and has been filtered.'}
        </Text>
        <Text align="center" size="sm" c="dimmed">
          Please try a different search term.
        </Text>
      </Stack>
    </Center>
  );
}
