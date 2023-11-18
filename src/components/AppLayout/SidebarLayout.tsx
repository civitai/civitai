import { createStyles } from '@mantine/core';

export function SidebarLayout({
  children,
  left: Left,
  right: Right,
}: {
  children: React.ReactNode;
  left?: () => JSX.Element;
  right?: () => JSX.Element;
}) {
  const { classes } = useStyles();

  if (!Left && !Right) return <>{children}</>;

  return (
    <div className={classes.container}>
      {Left && <Left />}
      <div className={classes.content}>{children}</div>
      {Right && <Right />}
    </div>
  );
}

const useStyles = createStyles((theme) => ({
  container: {
    display: 'flex',
  },
  content: {
    flex: 1,
  },
}));
