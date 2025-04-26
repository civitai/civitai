import { CardProps, Card, Stack, Text, Title } from '@mantine/core';
import styles from './SectionCard.module.scss';

export function SectionCard({
  title,
  subtitle,
  children,
  headerAlign = 'center',
  ...cardProps
}: Props) {
  return (
    <Card className={styles.card} radius="lg" {...cardProps}>
      <Stack align="center" spacing={48}>
        {(title || subtitle) && (
          <Stack spacing={4} align={headerAlign}>
            {title && (
              <Title order={2} size={32} align={headerAlign}>
                {title}
              </Title>
            )}
            {subtitle && (
              <Text color="dimmed" size="xl" align={headerAlign}>
                {subtitle}
              </Text>
            )}
          </Stack>
        )}
        {children}
      </Stack>
    </Card>
  );
}

type Props = CardProps & {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  headerAlign?: React.CSSProperties['textAlign'];
};

