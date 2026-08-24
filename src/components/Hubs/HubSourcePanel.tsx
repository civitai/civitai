import { useState } from 'react';
import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import { HubSourceEditor } from '~/components/Hubs/HubSourceEditor';
import { useInvalidateHub } from '~/components/Hubs/hub.utils';
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
  const invalidateHub = useInvalidateHub();
  const [pending, setPending] = useState<HubSourceValue[] | null>(null);
  const current = pending ?? sources;

  const upsert = trpc.userHub.upsert.useMutation({
    onSuccess: async () => {
      await invalidateHub(hubId);
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
