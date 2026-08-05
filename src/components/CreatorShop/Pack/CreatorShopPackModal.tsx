import {
  Alert,
  Badge,
  Button,
  Center,
  Checkbox,
  Divider,
  Group,
  Loader,
  Modal,
  NumberInput,
  Paper,
  ScrollArea,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconAlertTriangle, IconPlus, IconX } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { CosmeticThumb } from '~/components/CreatorShop/CosmeticThumb';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { ArtworkField } from '~/components/CreatorShop/Submit/ArtworkField';
import { useMutateCreatorShop } from '~/components/CreatorShop/creator-shop.util';
import type { CreatorShopManageItem } from '~/components/CreatorShop/creator-shop.util';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import {
  CREATOR_SHOP_SUBMISSION_FEE,
  PACK_MAX_MEMBERS,
  PACK_MIN_MEMBERS,
  RIGHTS_AFFIRMATION_STATEMENT,
  packPriceFloor,
  type PackMemberPricing,
} from '~/server/schema/creator-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Bundlable = PackMemberPricing & {
  name: string;
  data: unknown;
  createdById: number | null;
  creatorUsername: string | null;
  acceptsBlueBuzz: boolean;
};

const MAX_COVER_SIZE = 2 * 1024 * 1024;

export function CreatorShopPackModal({ item }: { item?: CreatorShopManageItem }) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const { submitPack, updatePack } = useMutateCreatorShop();
  const { uploadToCF, files, resetFiles } = useCFImageUpload();
  const isEdit = !!item;

  const [name, setName] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [price, setPrice] = useState<number | undefined>(item?.unitAmount);
  const [quantity, setQuantity] = useState<number | undefined>(
    item?.availableQuantity ?? undefined
  );
  const [acceptsBlueBuzz, setAcceptsBlueBuzz] = useState(false);
  const [rightsAffirmed, setRightsAffirmed] = useState(false);
  const [selected, setSelected] = useState<Bundlable[]>([]);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 400);
  const [imageId, setImageId] = useState<string | null>(null);
  const [localUrl, setLocalUrl] = useState<string | null>(null);

  const { data: existing, isLoading: loadingExisting } = trpc.creatorShop.getPack.useQuery(
    { id: item?.id ?? 0 },
    { enabled: !!item }
  );

  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!existing || hydrated) return;
    setHydrated(true);
    setSelected(
      existing.members.map((m) => ({
        cosmeticId: m.cosmeticId,
        type: m.type,
        listPrice: m.listPrice,
        isOwn: m.isOwn,
        name: m.name,
        data: m.data,
        // The detail endpoint reports ownership relative to the pack's lister,
        // which is what `isOwn` already carries.
        createdById: m.isOwn ? currentUser?.id ?? null : null,
        creatorUsername: m.creatorUsername,
        acceptsBlueBuzz: true,
      }))
    );
    setAcceptsBlueBuzz(!!existing.meta.acceptsBlueBuzz);
    setImageId(existing.meta.coverUrl ?? null);
  }, [existing, hydrated, currentUser?.id]);

  const { data: bundlable, isLoading: loadingBundlable } = trpc.creatorShop.getBundlable.useQuery({
    query: debouncedSearch || undefined,
    limit: 40,
  });

  const selectedIds = useMemo(() => new Set(selected.map((m) => m.cosmeticId)), [selected]);
  const options = (bundlable ?? []).filter((b) => !selectedIds.has(b.cosmeticId));

  // Ownership drives both the floor and the discount, so it's computed the same
  // way the server does rather than trusted from the picker.
  const members: PackMemberPricing[] = selected.map((m) => ({
    cosmeticId: m.cosmeticId,
    type: m.type,
    listPrice: m.listPrice,
    isOwn: m.createdById === currentUser?.id,
  }));
  const floor = members.length ? packPriceFloor(members) : 0;
  const foreignTotal = members.reduce((sum, m) => (m.isOwn ? sum : sum + m.listPrice), 0);
  const blueBlockers = selected.filter((m) => !m.acceptsBlueBuzz);
  const partTotal = selected.reduce((sum, m) => sum + m.listPrice, 0);

  const uploading = files.some((file) => file.status === 'uploading');
  const tooFew = selected.length < PACK_MIN_MEMBERS;
  const tooMany = selected.length > PACK_MAX_MEMBERS;
  const priceTooLow = (price ?? 0) < floor;
  const canSubmit =
    !!name.trim() &&
    !tooFew &&
    !tooMany &&
    !priceTooLow &&
    !uploading &&
    !!imageId &&
    (isEdit || rightsAffirmed) &&
    !(acceptsBlueBuzz && blueBlockers.length);

  const handleDrop = async (dropped: File[]) => {
    const file = dropped[0];
    if (!file) return;
    if (localUrl) URL.revokeObjectURL(localUrl);
    setLocalUrl(URL.createObjectURL(file));
    setImageId(null);
    try {
      const uploaded = await uploadToCF(file);
      setImageId(uploaded.id);
    } catch (error) {
      resetFiles();
      showErrorNotification({
        title: 'Upload failed',
        error: error instanceof Error ? error : new Error('Could not upload your cover art'),
      });
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit || !imageId || price == null) return;
    const memberCosmeticIds = selected.map((m) => m.cosmeticId);
    if (isEdit && item)
      await updatePack.mutateAsync({
        id: item.id,
        name,
        description: description || null,
        price,
        availableQuantity: quantity ?? null,
        acceptsBlueBuzz,
        imageUrl: imageId,
        memberCosmeticIds,
      });
    else
      await submitPack.mutateAsync({
        name,
        description: description || null,
        memberCosmeticIds,
        price,
        availableQuantity: quantity ?? null,
        buzzType: 'yellow',
        acceptsBlueBuzz,
        imageUrl: imageId,
        rightsAffirmed: true,
      });
    dialog.onClose();
  };

  return (
    <Modal {...dialog} size="xl" title={isEdit ? 'Edit pack' : 'Build a pack'} radius="lg">
      <Stack gap="md">
        {isEdit && loadingExisting && (
          <Center>
            <Loader type="bars" />
          </Center>
        )}
        <TextInput
          label="Pack name"
          withAsterisk
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <Textarea
          label="Description"
          autosize
          minRows={2}
          value={description ?? ''}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />

        <ArtworkField
          type={CosmeticType.Badge}
          artLocked={false}
          localUrl={localUrl}
          imageId={imageId}
          uploading={uploading}
          maxSize={MAX_COVER_SIZE}
          checks={[]}
          onDrop={handleDrop}
          onReplace={() => {
            setImageId(null);
            setLocalUrl(null);
            resetFiles();
          }}
        />

        <Divider label={`Contents (${selected.length}/${PACK_MAX_MEMBERS})`} />
        <Stack gap={6}>
          {selected.map((member) => (
            <Paper key={member.cosmeticId} withBorder radius="md" p="xs">
              <Group gap="xs" wrap="nowrap">
                <CosmeticThumb data={member.data} name={member.name} />
                <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                  <Text size="sm" fw={600} lineClamp={1}>
                    {member.name}
                  </Text>
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {getDisplayName(member.type)}
                    {member.creatorUsername ? ` · by @${member.creatorUsername}` : ''}
                  </Text>
                </Stack>
                <Text size="xs">{numberWithCommas(member.listPrice)} Buzz</Text>
                {!member.acceptsBlueBuzz && (
                  <Badge size="xs" color="gray" variant="light">
                    No Blue
                  </Badge>
                )}
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  leftSection={<IconX size={14} />}
                  onClick={() =>
                    setSelected((cur) => cur.filter((m) => m.cosmeticId !== member.cosmeticId))
                  }
                >
                  Remove
                </Button>
              </Group>
            </Paper>
          ))}
          {tooFew && (
            <Text size="xs" c="dimmed">
              A pack needs at least {PACK_MIN_MEMBERS} items.
            </Text>
          )}
        </Stack>

        <TextInput
          label="Add items"
          placeholder="Search published cosmetics"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <ScrollArea.Autosize mah={220}>
          <Stack gap={6}>
            {loadingBundlable && (
              <Center py="sm">
                <Loader size="sm" />
              </Center>
            )}
            {options.map((option) => (
              <Paper key={option.cosmeticId} withBorder radius="md" p="xs">
                <Group gap="xs" wrap="nowrap">
                  <CosmeticThumb data={option.data} name={option.name} />
                  <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                    <Text size="sm" lineClamp={1}>
                      {option.name}
                    </Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {getDisplayName(option.type)}
                      {option.creatorUsername ? ` · by @${option.creatorUsername}` : ''}
                    </Text>
                  </Stack>
                  <Text size="xs">{numberWithCommas(option.listPrice)} Buzz</Text>
                  <Button
                    size="compact-xs"
                    variant="light"
                    leftSection={<IconPlus size={14} />}
                    disabled={selected.length >= PACK_MAX_MEMBERS}
                    onClick={() => setSelected((cur) => [...cur, option as Bundlable])}
                  >
                    Add
                  </Button>
                </Group>
              </Paper>
            ))}
          </Stack>
        </ScrollArea.Autosize>

        <Divider label="Pricing" />
        <NumberInput
          label="Pack price"
          withAsterisk
          min={floor || undefined}
          value={price}
          onChange={(value) => setPrice(typeof value === 'number' ? value : undefined)}
          description={
            members.length
              ? `At least ${numberWithCommas(
                  floor
                )} Buzz. Items other creators made (${numberWithCommas(
                  foreignTotal
                )} Buzz) must be covered at their own price.`
              : 'Add items to see the minimum.'
          }
          error={priceTooLow && price != null ? `Minimum is ${numberWithCommas(floor)} Buzz` : null}
        />
        {price != null && partTotal > price && (
          <Text size="xs" c="dimmed">
            Bought separately these cost {numberWithCommas(partTotal)} Buzz — this pack saves{' '}
            {numberWithCommas(partTotal - price)}.
          </Text>
        )}
        <NumberInput
          label="Available quantity"
          description="Leave empty for unlimited."
          min={1}
          value={quantity}
          onChange={(value) => setQuantity(typeof value === 'number' ? value : undefined)}
        />

        <Switch
          label="Accept Blue Buzz"
          checked={acceptsBlueBuzz}
          onChange={(e) => setAcceptsBlueBuzz(e.currentTarget.checked)}
          disabled={blueBlockers.length > 0}
        />
        {blueBlockers.length > 0 && (
          <Alert color="gray" icon={<IconAlertTriangle size={18} />}>
            {/* Named rather than silently disabled: the constraint belongs to a
                specific member, and the builder can swap it out. */}
            This pack can&apos;t accept Blue Buzz because{' '}
            {blueBlockers.map((m) => m.name).join(', ')} {blueBlockers.length > 1 ? 'do' : 'does'}{' '}
            not.
          </Alert>
        )}

        {!isEdit && (
          <Checkbox
            checked={rightsAffirmed}
            onChange={(e) => setRightsAffirmed(e.currentTarget.checked)}
            label={RIGHTS_AFFIRMATION_STATEMENT}
          />
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          {isEdit ? (
            <Button disabled={!canSubmit} loading={updatePack.isPending} onClick={handleSubmit}>
              Save pack
            </Button>
          ) : (
            <BuzzTransactionButton
              disabled={!canSubmit}
              loading={submitPack.isPending}
              buzzAmount={CREATOR_SHOP_SUBMISSION_FEE}
              label="Submit pack"
              onPerformTransaction={handleSubmit}
            />
          )}
        </Group>
        {existing?.status && (
          <Text size="xs" c="dimmed">
            Changing the contents or the price sends this pack back through review.
          </Text>
        )}
      </Stack>
    </Modal>
  );
}
