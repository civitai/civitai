import { Card, Title } from '@mantine/core';
import { GenerationSettings } from '~/components/Generation/GenerationSettings';

export function GenerationSettingsCard() {
  return (
    <Card className="flex flex-col gap-3">
      <Title order={2}>Generation Settings</Title>
      <GenerationSettings />
    </Card>
  );
}
