import { Card, Divider, Text } from '@mantine/core';
import { IconDatabase } from '@tabler/icons-react';
import { titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function ImageExternalMeta({ imageId }: { imageId: number }) {
  const { data } = trpc.image.getGenerationData.useQuery({ id: imageId });

  const { external } = data ?? {};
  if (!external) return null;

  const hasSource = !!external.source && Object.keys(external.source).length > 0;
  const hasReference = !!external.referenceUrl;
  const hasCreate = !!external.createUrl;
  const hasDetails = !!external.details && Object.keys(external.details).length > 0;

  return (
    <Card className="rounded-xl flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Text className="flex items-center gap-2 font-semibold text-xl">
          <IconDatabase />
          <span>External data</span>
        </Text>
      </div>
      <div className="flex flex-col">
        {/* TODO make URLs */}
        {hasSource && (
          <div className="flex justify-between gap-3">
            <Text color="dimmed" className="leading-snug text-nowrap">
              Source
            </Text>
            {external.source?.name ? (
              <Text className="leading-snug">
                {external.source?.name}
                {external.source?.homepage && ` (${external.source?.homepage})`}
              </Text>
            ) : (
              <Text className="leading-snug">{external.source?.homepage}</Text>
            )}
          </div>
        )}
        {hasReference && (
          <div className="flex justify-between gap-3">
            <Text color="dimmed" className="leading-snug text-nowrap">
              Media URL
            </Text>
            <Text className="leading-snug">{external.referenceUrl}</Text>
          </div>
        )}
        {hasCreate && (
          <div className="flex justify-between gap-3">
            <Text color="dimmed" className="leading-snug text-nowrap">
              Create URL
            </Text>
            <Text className="leading-snug">{external.createUrl}</Text>
          </div>
        )}
        {hasDetails && (
          <>
            {(hasSource || hasReference || hasCreate) && <Divider my="sm" />}
            <Text className="text-md font-semibold">Other metadata</Text>
            {Object.entries(external.details ?? {}).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <Text color="dimmed" className="leading-snug text-nowrap">
                  {titleCase(k)}
                </Text>
                <Text className="leading-snug">{v.toString()}</Text>
              </div>
            ))}
          </>
        )}
      </div>
    </Card>
  );
}
