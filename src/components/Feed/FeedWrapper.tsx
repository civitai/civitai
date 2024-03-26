import { Alert } from '@mantine/core';
import { useRouter } from 'next/router';
import React, { useMemo } from 'react';
import { z } from 'zod';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useHiddenPreferencesContext } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { NoContent } from '~/components/NoContent/NoContent';
import { numericStringArray } from '~/utils/zod-helpers';

const schema = z.object({ tags: numericStringArray().optional() });

export function FeedWrapper({ children }: { children: React.ReactElement }) {
  const router = useRouter();
  const { moderatedTags } = useHiddenPreferencesContext();
  const browsingLevel = useBrowsingLevelDebounced();

  const incompatibleTags = useMemo(() => {
    const { tags = [] } = schema.parse(router.query);
    const moderatedTagIds = moderatedTags
      .filter((x) => !!x.nsfwLevel && x.nsfwLevel > browsingLevel && tags?.includes(x.id))
      .map((x) => x.id);
    return !!tags.length && tags.every((id) => moderatedTagIds.includes(id));
  }, [browsingLevel, router, moderatedTags]);

  if (incompatibleTags) {
    return <NoContent p="xl" />;
  }

  return children;
}
