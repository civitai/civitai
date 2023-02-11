import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ModelHashModel } from '~/server/selectors/modelHash.selector';

export function CivitaiLinkQuickAdd({
  modelId,
  hashes,
}: {
  modelId: number;
  hashes: ModelHashModel[];
}) {
  const currentUser = useCurrentUser(); // TODO.justin - use current user to determine what resources to add
  const { resources } = useCivitaiLink();

  // TODO - do we have hashes for config files?
  // if (modelId === 2107) console.log({ hashes });

  const match = resources.find((resource) =>
    hashes.some((x) => x.hash.toLowerCase() === resource.hash)
  );
  // if (match) {
  //   console.log({ match });
  // }

  return <></>;
}
