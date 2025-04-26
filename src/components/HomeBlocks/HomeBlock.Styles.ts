import { containerQuery } from '~/utils/mantine-css-helpers';
import styles from './HomeBlock.module.scss';

export const useHomeBlockStyles = () => {
  return {
    classes: styles,
  };
};

export const useHomeBlockGridStyles = (count: number, rows: number) => {
  const gridStyle = {
    '--grid-count': count.toString(),
    '--grid-rows': rows.toString(),
  } as React.CSSProperties;

  return {
    classes: {
      title: styles.title,
      expandButton: styles.expandButton,
      header: styles.header,
      grid: styles.grid,
    },
    gridStyle,
  };
};
