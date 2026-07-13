import { Group, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { CheckRow, ChecksCard } from '~/components/CreatorShop/ChecksCard';
import { CREATOR_SHOP_BORDER } from '~/components/CreatorShop/creator-shop.constants';
import { requirementRows } from '~/components/CreatorShop/Submit/submit.util';
import type { AutoCheck } from '~/server/schema/creator-shop.schema';
import type { CosmeticType } from '~/shared/utils/prisma/enums';

// The submission requirements. Rendered neutral (as up-front requirements) before
// an image is chosen, then with pass/fail results once one is.
export function ChecksPanel({
  type,
  maxSize,
  checks,
}: {
  type: CosmeticType;
  maxSize: number;
  checks: AutoCheck[];
}) {
  const hasResults = checks.length > 0;
  const rows = hasResults ? checks : requirementRows(type, maxSize);
  const allPassed = hasResults && checks.every((c) => c.passed);
  return (
    <ChecksCard
      icon={<IconInfoCircle size={15} color="var(--mantine-color-dimmed)" />}
      title="Requirements"
    >
      {rows.map((r, i) => (
        <CheckRow
          key={r.key}
          state={!hasResults ? 'neutral' : r.passed ? 'pass' : 'fail'}
          label={r.label}
          detail={r.detail}
          withBorder={i < rows.length - 1}
          emphasizeFail
        />
      ))}
      {hasResults && !allPassed && (
        <Group px="md" py={9} style={{ borderTop: CREATOR_SHOP_BORDER }}>
          <Text size="xs" c="red">
            Your image doesn&apos;t meet the requirements above — replace it to continue.
          </Text>
        </Group>
      )}
    </ChecksCard>
  );
}
