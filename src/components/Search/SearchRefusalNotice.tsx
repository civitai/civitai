import { Anchor, Center, List, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import Link from 'next/link';
import { refusedByOf, type SearchRefusal } from '~/components/Search/search-refusal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  SEARCH_POLICY_MESSAGE,
  searchRefusedByLine,
  type SearchRefusedBy,
} from '~/shared/constants/search-refusal.constants';

/**
 * What a refused search shows in place of results, on the search pages and on a searched feed.
 * Every refusal but the minors one shows the same message, which names no rule and no term.
 * `refusedBy` is the server's moderator view (absent for everyone else); a refusal decided in the
 * browser names its own check, to a moderator only.
 */
export function SearchRefusalNotice({
  refusal,
  refusedBy,
}: {
  refusal: SearchRefusal;
  refusedBy?: SearchRefusedBy;
}) {
  const currentUser = useCurrentUser();
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

  return (
    <SearchPolicyMessage
      refusedBy={currentUser?.isModerator ? refusedBy ?? refusedByOf(refusal) : undefined}
    />
  );
}

/** The policy message, with the moderator's line when one is given; `compact` for the dropdown. */
export function SearchPolicyMessage({
  refusedBy,
  compact = false,
}: {
  refusedBy?: SearchRefusedBy;
  compact?: boolean;
}) {
  if (compact)
    return (
      <Stack gap="xs" align="center">
        <Text size="sm" align="center" weight={600}>
          {SEARCH_POLICY_MESSAGE.title}
        </Text>
        <Text size="xs" align="center">
          {SEARCH_POLICY_MESSAGE.body}
        </Text>
        {refusedBy && (
          <Text size="xs" align="center" c="dimmed">
            {searchRefusedByLine(refusedBy)}
          </Text>
        )}
      </Stack>
    );
  return (
    <Center>
      <Stack maw={750} align="center" gap="xs" className="h-full py-8">
        <IconAlertTriangle size={42} color="orange" />
        <Text weight={700} size="lg" align="center">
          {SEARCH_POLICY_MESSAGE.title}
        </Text>
        <Text align="center">{SEARCH_POLICY_MESSAGE.body}</Text>
        {refusedBy && (
          <Text align="center" size="sm" c="dimmed">
            {searchRefusedByLine(refusedBy)}
          </Text>
        )}
      </Stack>
    </Center>
  );
}
