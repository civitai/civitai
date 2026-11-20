import { Button, CloseButton, Group } from '@mantine/core';
import { IconBox } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import { parseModelVersionIds } from '~/components/Image/Infinite/image-feed-search';
import { MAX_SEARCH_MODEL_VERSIONS } from '~/server/schema/semantic-image-search.schema';
import { removeEmpty } from '~/utils/object-helpers';

/**
 * The image search's "Made with" filter: the model versions in `?modelVersionIds=`, picked from the
 * generator's resource picker. Rendered only while searching with `imageSearchResources` on.
 */
export function SearchResourceFilter() {
  const router = useRouter();
  const selected = parseModelVersionIds(router.query.modelVersionIds);

  const write = (ids: number[]) =>
    router.replace(
      {
        pathname: router.pathname,
        query: removeEmpty({ ...router.query, modelVersionIds: ids.join(',') || undefined }),
      },
      undefined,
      { shallow: true, scroll: false }
    );

  const pick = () =>
    openResourceSelectModal({
      title: 'Images made with',
      limit: MAX_SEARCH_MODEL_VERSIONS - selected.length,
      onSelect: (resource) => write([...selected, resource.id]),
      onSelectMultiple: (resources) => write([...selected, ...resources.map((r) => r.id)]),
    });

  return (
    <Group gap={4} wrap="nowrap">
      <Button
        size="compact-sm"
        variant={selected.length ? 'light' : 'default'}
        leftSection={<IconBox size={14} />}
        onClick={pick}
        disabled={selected.length >= MAX_SEARCH_MODEL_VERSIONS}
      >
        {selected.length ? `Made with ${selected.length}` : 'Made with'}
      </Button>
      {!!selected.length && (
        <CloseButton size="sm" aria-label="Clear made with" onClick={() => write([])} />
      )}
    </Group>
  );
}
