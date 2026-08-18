import { Badge, Code, Stack, Text, Title } from '@mantine/core';
import type { InferGetServerSidePropsType } from 'next';
import { Page } from '~/components/AppLayout/Page';
import { TryItForm } from '~/components/Moderator/TryItForm';
import { TwCard } from '~/components/TwCard/TwCard';
import type { CatalogEntry } from '~/server/utils/moderator-endpoint-catalog';
import { moderatorEndpointCatalog } from '~/server/utils/moderator-endpoint-catalog';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

// The moderator API reference. Every entry is read off the endpoint's own spec, and the params come
// from the zod schema that validates the request — so this page cannot describe a contract the code
// does not enforce. The catalog is generated, so defining an endpoint is what lists it here.

/**
 * One section per domain — the flat list stops being readable around the second domain, and there are
 * a dozen.
 *
 * The domain is the segment under `/api/mod`, NOT the parent directory: most endpoints are
 * `/api/mod/<domain>/<action>` and the two agree, but a domain-level one like `/api/mod/whoami` has no
 * action, and taking its parent filed it under a bare `/api/mod` alongside nothing else.
 */
const groupOf = (path: string) => path.split('/').slice(0, 4).join('/');
const anchorOf = (group: string) => group.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');

function groupEndpoints(endpoints: CatalogEntry[]) {
  const groups: { group: string; anchor: string; items: CatalogEntry[] }[] = [];
  // The catalog is sorted by path, so entries in a directory arrive contiguously and a running
  // comparison is enough — no map, and the order stays the catalog's rather than insertion order.
  for (const endpoint of endpoints) {
    const group = groupOf(endpoint.path);
    const last = groups[groups.length - 1];
    if (last?.group === group) last.items.push(endpoint);
    else groups.push({ group, anchor: anchorOf(group), items: [endpoint] });
  }
  return groups;
}

function EndpointCard({ endpoint }: { endpoint: CatalogEntry }) {
  // A module that would not load is shown as a broken endpoint rather than omitted: an endpoint
  // missing from this page reads as an endpoint that does not exist.
  if (!endpoint.doc) {
    return (
      <TwCard className="gap-1 border border-red-500/40 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge color="red">unavailable</Badge>
          <Code>{endpoint.path}</Code>
        </div>
        <Text size="sm" c="red">
          {endpoint.loadError ?? 'Could not be described.'}
        </Text>
      </TwCard>
    );
  }

  const doc = endpoint.doc;
  return (
    <TwCard className="gap-2 border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge color={doc.method === 'GET' ? 'blue' : 'green'}>{doc.method}</Badge>
        <Code>{endpoint.path}</Code>
        {doc.privileged && (
          <Badge color="orange" title="Requires this permission on top of the moderator role">
            {doc.privileged}
          </Badge>
        )}
        <Text size="xs" c="dimmed">
          {doc.rateLimit.max}/{doc.rateLimit.windowSeconds}s
        </Text>
      </div>

      <Text size="sm">{doc.summary}</Text>

      {doc.params.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-gray-500">
              <th className="py-1 pr-3">Param</th>
              <th className="py-1 pr-3">Type</th>
              <th className="py-1">Description</th>
            </tr>
          </thead>
          <tbody>
            {doc.params.map((param) => (
              <tr key={param.name} className="align-top">
                <td className="py-1 pr-3">
                  <Code>{param.name}</Code>
                  {param.required && <span className="ml-1 text-red-500">*</span>}
                </td>
                <td className="py-1 pr-3 text-gray-500">{param.type}</td>
                <td className="py-1">{param.description ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {doc.returns && (
        <Text size="xs" c="dimmed">
          Returns <Code>{doc.returns}</Code>
        </Text>
      )}

      {doc.notes?.map((note) => (
        <Text key={note} size="xs" c="dimmed">
          {note}
        </Text>
      ))}

      <TryItForm path={endpoint.path} doc={doc} />
    </TwCard>
  );
}

function ModeratorApiPage({ endpoints }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const groups = groupEndpoints(endpoints);

  return (
    <div className="container max-w-4xl py-4">
      <Title order={1} className="mb-1">
        Moderator API
      </Title>
      <Text size="sm" c="dimmed" className="mb-4">
        Every endpoint accepts a moderator session from the browser, a moderator API key as{' '}
        <Code>Authorization: Bearer</Code>, or that same session forwarded by a spoke. All three
        resolve to a real moderator, and the rate limit and audit trail are per person.
      </Text>

      {groups.length > 1 && (
        <nav className="mb-6 flex flex-wrap gap-x-3 gap-y-1 text-sm">
          {groups.map(({ group, anchor, items }) => (
            <a key={anchor} href={`#${anchor}`} className="text-blue-4 hover:underline">
              {group.replace('/api/mod/', '')}{' '}
              <span className="text-gray-500">({items.length})</span>
            </a>
          ))}
        </nav>
      )}

      <Stack gap="xl">
        {groups.map(({ group, anchor, items }) => (
          <section key={anchor} id={anchor} className="scroll-mt-4">
            <Title order={2} size="h4" className="mb-2">
              <Code>{group}</Code>
            </Title>
            <Stack gap="md">
              {items.map((endpoint) => (
                <EndpointCard key={endpoint.path} endpoint={endpoint} />
              ))}
            </Stack>
          </section>
        ))}
      </Stack>
    </div>
  );
}

export const getServerSideProps = createServerSideProps({
  requireModerator: true,
  resolver: async () => ({ props: { endpoints: await moderatorEndpointCatalog() } }),
});

export default Page(ModeratorApiPage);
