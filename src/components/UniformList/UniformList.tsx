import { createStyles } from '@mantine/core';
import { ModelCard } from '~/components/ModelCard/ModelCard';
import { GetAllModelsReturnType } from '~/server/services/models/getAllModels';

type UniformListProps = {
  columnWidth: number;
  data: GetAllModelsReturnType['items'];
};

export function UniformList({ columnWidth, data }: UniformListProps) {
  const { classes } = useStyles({ columnWidth });

  return (
    <div className={classes.gridLayout}>
      {data.map((model) => (
        <ModelCard key={model.id} {...model} />
      ))}
    </div>
  );
}

const useStyles = createStyles((theme, { columnWidth }: { columnWidth: number }) => ({
  gridLayout: {
    display: 'grid',
    gridTemplateColumns: `repeat(auto-fit, ${columnWidth}px)`,
    gap: '16px',
    justifyContent: 'center',
  },
}));
