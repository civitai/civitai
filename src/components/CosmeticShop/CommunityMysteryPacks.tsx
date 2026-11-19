import { Center, Loader, Stack } from '@mantine/core';
import { MysteryBoxCatalogCard } from '~/components/MysteryBox/MysteryBoxCatalogCard';
import { NoContent } from '~/components/NoContent/NoContent';
import { trpc } from '~/utils/trpc';

/** The community's live mystery packs, for the /shop "Mystery packs" filter; `search` matches the name. */
export function CommunityMysteryPacks({ search }: { search?: string }) {
  const { data, isLoading } = trpc.mysteryBox.getForCreator.useQuery({});
  const term = search?.trim().toLowerCase();
  const packs = (data ?? []).filter(
    (box) =>
      !term ||
      box.name.toLowerCase().includes(term) ||
      box.seller.username?.toLowerCase().includes(term)
  );

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (!packs.length) return <NoContent message="No mystery packs match your search right now." />;
  return (
    <Stack gap="md" data-testid="community-mystery-packs">
      {packs.map((box) => (
        <MysteryBoxCatalogCard key={box.boxDefinitionId} box={box} />
      ))}
    </Stack>
  );
}
