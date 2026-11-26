import { Input, SegmentedControl } from '@mantine/core';
import { useBrowsingSettings, useShowEventCosmetics } from '~/providers/BrowserSettingsProvider';
import type { EventPointPops } from '~/shared/constants/event-point-pops.constants';

const options: { value: EventPointPops; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active only' },
];

/** Which point pops this viewer sees. Hidden with event cosmetics off, when no pop shows at all. */
export function EventPointPopsSetting({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const showEventCosmetics = useShowEventCosmetics();
  const value = useBrowsingSettings((x) => x.eventPointPops);
  const setState = useBrowsingSettings((x) => x.setState);
  if (!showEventCosmetics) return null;
  return (
    <Input.Wrapper
      label="Point pops"
      description="Active only: from your own reactions. All: whenever your points go up."
      size={size}
    >
      <SegmentedControl
        className="mt-1"
        size={size === 'sm' ? 'xs' : 'sm'}
        value={value}
        onChange={(next) => setState({ eventPointPops: next as EventPointPops })}
        data={options}
        data-testid="event-point-pops-setting"
      />
    </Input.Wrapper>
  );
}
