import { HoverCard, Text } from '@mantine/core';

export function ComingSoon({ children, message }: { children: React.ReactNode; message?: string }) {
  return (
    <HoverCard withArrow width={250} openDelay={500}>
      <HoverCard.Target>{children}</HoverCard.Target>
      <HoverCard.Dropdown>
        <Text color="yellow" weight={500}>
          Coming soon!
        </Text>
        {message ? (
          <Text size="sm">{message}</Text>
        ) : (
          <Text size="sm">{`We're still working on this feature. Check back soon!`}</Text>
        )}
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
