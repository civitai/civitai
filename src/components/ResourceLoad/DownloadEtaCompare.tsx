import { Text } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { downloadSpeedup, formatDownloadEtaShort } from '~/components/ResourceLoad/download-eta';

export function DownloadEtaCompare({
  etaSeconds,
  boostedEtaSeconds,
  beforeLabel = 'Normally',
  afterLabel = 'Boosted',
  struck,
}: {
  etaSeconds: number;
  boostedEtaSeconds: number;
  beforeLabel?: string;
  afterLabel?: string;
  /** Once bought, the slower time is the receipt, not an option. */
  struck?: boolean;
}) {
  const speedup = downloadSpeedup(etaSeconds, boostedEtaSeconds);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <EtaBlock label={beforeLabel} dimmed struck={struck}>
        {formatDownloadEtaShort(etaSeconds)}
      </EtaBlock>
      <IconArrowRight size={16} className="text-dimmed" aria-hidden />
      <EtaBlock label={afterLabel}>{formatDownloadEtaShort(boostedEtaSeconds)}</EtaBlock>
      {speedup && (
        <span className="ml-auto whitespace-nowrap rounded-full bg-yellow-5/15 px-2 py-0.5 text-[11px] font-bold text-yellow-6">
          {speedup}× faster
        </span>
      )}
    </div>
  );
}

function EtaBlock({
  label,
  dimmed,
  struck,
  children,
}: {
  label: string;
  dimmed?: boolean;
  struck?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <Text c="dimmed" fw={700} tt="uppercase" className="text-[9.5px] tracking-wider">
        {label}
      </Text>
      <Text
        fw={700}
        lh={1.15}
        c={dimmed ? 'dimmed' : 'yellow.6'}
        td={struck ? 'line-through' : undefined}
        className="text-lg tabular-nums"
      >
        {children}
      </Text>
    </div>
  );
}
