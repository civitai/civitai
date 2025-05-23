import { Stack, Title, Text, StackProps } from '@mantine/core';

export function StepperTitle({
  title,
  description,
  ...props
}: { title: React.ReactNode; description?: React.ReactNode } & Omit<StackProps, 'title'>) {
  return (
    <Stack gap={4} {...props}>
      <Title order={3} className="leading-[1.1]">
        {title}
      </Title>
      {description && <Text>{description}</Text>}
    </Stack>
  );
}
