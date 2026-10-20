import { Alert, Group, Input, Loader, Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import clsx from 'clsx';
import { useFormContext, useWatch } from 'react-hook-form';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { trpc } from '~/utils/trpc';

type CoverForm = {
  nsfw?: boolean;
  sfwName?: string | null;
  coverImageId?: number | null;
  sfwCoverImageId?: number | null;
};

type CoverField = 'coverImageId' | 'sfwCoverImageId';

const isSafeLevel = (nsfwLevel: number) =>
  !!nsfwLevel && (nsfwLevel & sfwBrowsingLevelsFlag) === nsfwLevel;

/** The model's cover per site, picked from the creator's own published images on the model. */
export function ModelCoverFields({ modelId }: { modelId: number }) {
  const features = useFeatureFlags();
  const form = useFormContext<CoverForm>();
  const [nsfw, sfwName, coverImageId, sfwCoverImageId] = useWatch({
    control: form.control,
    name: ['nsfw', 'sfwName', 'coverImageId', 'sfwCoverImageId'],
  });
  const { data: candidates = [], isLoading } = trpc.model.getCoverCandidates.useQuery({
    id: modelId,
  });
  const safeCandidates = candidates.filter((image) => isSafeLevel(image.nsfwLevel));

  const setCover = (field: CoverField, id: number | null) =>
    form.setValue(field, id, { shouldDirty: true });

  return (
    <Paper radius="md" p="md" withBorder>
      <Stack gap="md">
        <div>
          <Text fw={500}>Covers</Text>
          <Text size="xs" c="dimmed">
            Pick the image each site leads with. Without a pick, the first image of your latest
            version is used. Click a picked image again to clear it.
          </Text>
        </div>
        {isLoading ? (
          <Loader size="sm" />
        ) : !candidates.length ? (
          <Text size="sm" c="dimmed">
            Publish a post with images on this model to pick a cover.
          </Text>
        ) : (
          <>
            {features.canViewNsfw ? (
              <CoverGrid
                label="civitai.red cover"
                images={candidates}
                value={coverImageId}
                onChange={(id) => setCover('coverImageId', id)}
              />
            ) : (
              <Text size="xs" c="dimmed">
                Pick the civitai.red cover from civitai.red.
              </Text>
            )}
            {sfwName != null ? (
              <>
                <CoverGrid
                  label="civitai.com cover"
                  description="Only your images rated PG or PG-13 can lead on civitai.com."
                  images={safeCandidates}
                  value={sfwCoverImageId}
                  onChange={(id) => setCover('sfwCoverImageId', id)}
                  empty="None of your images on this model are rated PG or PG-13 yet."
                />
                {nsfw && !sfwCoverImageId && (
                  <Alert color="yellow" p="xs">
                    <Text size="xs">
                      This model is marked mature, so it stays off civitai.com until you pick a
                      civitai.com cover.
                    </Text>
                  </Alert>
                )}
              </>
            ) : (
              <Text size="xs" c="dimmed">
                Turn on a different title for civitai.com to pick a civitai.com cover.
              </Text>
            )}
          </>
        )}
      </Stack>
    </Paper>
  );
}

function CoverGrid({
  label,
  description,
  images,
  value,
  onChange,
  empty,
}: {
  label: string;
  description?: string;
  images: { id: number; url: string; type: MediaType; metadata: unknown }[];
  value?: number | null;
  onChange: (id: number | null) => void;
  empty?: string;
}) {
  return (
    <Input.Wrapper label={label} description={description}>
      {!images.length ? (
        <Text size="xs" c="dimmed" mt="xs">
          {empty}
        </Text>
      ) : (
        <Group gap="xs" mt="xs">
          {images.map((image) => {
            const selected = image.id === value;
            return (
              <UnstyledButton
                key={image.id}
                type="button"
                aria-label={`Use image ${image.id} as the ${label}`}
                aria-pressed={selected}
                onClick={() => onChange(selected ? null : image.id)}
                className={clsx(
                  'overflow-hidden rounded-md border-2 border-solid',
                  selected ? 'border-blue-5' : 'border-transparent'
                )}
              >
                <EdgeMedia2
                  src={image.url}
                  type={image.type}
                  metadata={image.metadata as never}
                  width={90}
                  anim={false}
                  className="size-[90px] object-cover"
                />
              </UnstyledButton>
            );
          })}
        </Group>
      )}
    </Input.Wrapper>
  );
}

type MediaType = Parameters<typeof EdgeMedia2>[0]['type'];
