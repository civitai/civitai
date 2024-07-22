import { ModelCard } from '~/components/Cards/ModelCard';
import { useModelFilters, useQueryModels } from '~/components/Model/model.utils';
import {
  AspectRatio,
  Box,
  Skeleton,
  Stack,
  Badge,
  Anchor,
  UnstyledButton,
  Group,
  Text,
  Button,
} from '@mantine/core';
import { useHomeBlockGridStyles } from '~/components/HomeBlocks/HomeBlock.Styles';
import { ShowcaseGrid } from '~/components/Profile/Sections/ShowcaseGrid';
import { IconArrowRight } from '@tabler/icons-react';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

const ITEMS_PER_ROW = 7;

export const EarlyAccessHighlight = () => {
  const features = useFeatureFlags();
  const modelFilters = useModelFilters();

  const { setFilters } = useFiltersContext((state) => ({
    setFilters: state.setModelFilters,
  }));

  const { models, isLoading, isRefetching, hasNextPage } = useQueryModels(
    {
      ...modelFilters,
      earlyAccess: true,
      limit: 15,
    },
    {
      enabled: !modelFilters.earlyAccess,
    }
  );

  const { classes, theme } = useHomeBlockGridStyles({
    count: models?.length ?? 15,
    rows: 1,
  });

  const onViewAll = () => {
    setFilters({ earlyAccess: true });
  };

  if (modelFilters.earlyAccess || !features.earlyAccessModel) {
    return null;
  }

  if (isLoading || isRefetching) {
    return (
      <Box className={classes.grid}>
        {Array.from({ length: ITEMS_PER_ROW }).map((_, index) => (
          <AspectRatio ratio={7 / 9} key={index}>
            <Skeleton width="100%" />
          </AspectRatio>
        ))}
      </Box>
    );
  }

  if (!isLoading && !models.length) {
    // No early access models found
    return null;
  }

  return (
    <Stack mb="md">
      <Badge>Check out some early access models matching your query</Badge>
      <ShowcaseGrid itemCount={models.length + (hasNextPage ? 1 : 0)} rows={1} carousel={true}>
        {models.map((model) => (
          <ModelCard key={model.id} data={model} />
        ))}
        {hasNextPage && (
          <Button
            variant="outline"
            style={{
              background: theme.fn.rgba(theme.colors.blue[8], 0.2),
              borderRadius: theme.radius.md,
            }}
            onClick={onViewAll}
          >
            <AspectRatio ratio={7 / 9}>
              <Group>
                <Text>View All</Text> <IconArrowRight />
              </Group>
            </AspectRatio>
          </Button>
        )}
      </ShowcaseGrid>
      <Badge mt="-md" />
    </Stack>
  );
};
