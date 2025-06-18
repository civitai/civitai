import type { CardProps } from '@mantine/core';
import { Card, Stack, Text, Title } from '@mantine/core';

export function SectionCard({
  title,
  subtitle,
  children,
  headerAlign = 'center',
  ...cardProps
}: Props) {
  return (
    <Card className="bg-gray-0 p-4 md:p-8 dark:bg-dark-6" radius="lg" {...cardProps}>
      <Stack align="center" gap={48}>
        {(title || subtitle) && (
          <Stack gap={4} align={headerAlign}>
            {title && (
              <Title order={2} size={32} ta={headerAlign}>
                {title}
              </Title>
            )}
            {subtitle && (
              <Text c="dimmed" size="xl" align={headerAlign}>
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
