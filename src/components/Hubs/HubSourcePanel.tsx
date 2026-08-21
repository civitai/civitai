import { useState } from 'react';
import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import { HubSourceEditor } from '~/components/Hubs/HubSourceEditor';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function HubSourcePanel({
  hubId,
  sources,
  maxSources,
  hideAdd,
}: {
  hubId: number;
  sources: HubSourceValue[];
  maxSources: number;
  hideAdd?: boolean;
}) {
  const utils = trpc.useUtils();
  const [pending, setPending] = useState<HubSourceValue[] | null>(null);
  const current = pending ?? sources;

  const upsert = trpc.userHub.upsert.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.userHub.getById.invalidate({ id: hubId }),
        utils.userHub.getAll.invalidate(),
      ]);
      // The feed is keyed on hubId, not on the source list, so it will not refetch
      // on its own when the sources behind it change.
      await utils.image.getInfinite.invalidate({ hubId });
      setPending(null);
    },
    onError: (error) => {
      // Roll the optimistic list back — leaving it applied would show a source the
      // server refused (a private or rating-capped collection) as if it were saved.
      setPending(null);
      showErrorNotification({ title: 'Could not save sources', error: new Error(error.message) });
    },
  });

  return (
    <HubSourceEditor
      value={current}
      maxSources={maxSources}
      hideAdd={hideAdd}
      disabled={upsert.isPending}
      emptyMessage="Nothing here yet. Add a creator, a model or a public collection."
      onChange={(next) => {
        setPending(next);
        upsert.mutate({ id: hubId, sources: next.map((s, index) => ({ ...s, index })) });
      }}
    />
  );
}
