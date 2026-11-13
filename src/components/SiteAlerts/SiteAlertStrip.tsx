import {
  IconAlertOctagon,
  IconAlertTriangle,
  IconCircleCheck,
  IconInfoCircle,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { SiteAlert, SiteAlertSeverity } from '~/shared/constants/site-alert.constants';

const severityStyle: Record<SiteAlertSeverity, { className: string; Icon: typeof IconX }> = {
  outage: { className: 'bg-red-9 text-white', Icon: IconAlertOctagon },
  warning: { className: 'bg-yellow-5 text-dark-9', Icon: IconAlertTriangle },
  info: { className: 'bg-blue-8 text-white', Icon: IconInfoCircle },
  resolved: { className: 'bg-green-8 text-white', Icon: IconCircleCheck },
};

export function SiteAlertStrip({ alert, onDismiss }: { alert: SiteAlert; onDismiss?: () => void }) {
  const { className, Icon } = severityStyle[alert.severity];

  return (
    <div
      role="status"
      className={clsx('flex min-h-11 w-full items-center gap-3 px-4 py-2', className)}
      data-testid="site-alert"
      data-severity={alert.severity}
    >
      <Icon size={20} className="shrink-0" aria-hidden />
      <p className="m-0 min-w-0 flex-1 text-sm leading-snug">
        <span className="font-bold">{alert.title}</span>
        {alert.message && <span className="opacity-90"> {alert.message}</span>}
      </p>
      {alert.dismissible && onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss ${alert.title}`}
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-current opacity-70 hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-current"
        >
          <IconX size={18} />
        </button>
      )}
    </div>
  );
}
