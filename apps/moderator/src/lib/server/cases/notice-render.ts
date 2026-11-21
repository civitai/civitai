import type { NOTICE_SLOTS } from '@civitai/moderation/process-definition';

export type NoticeSlots = Partial<Record<(typeof NOTICE_SLOTS)[number], string>>;

/**
 * Fills a notice's {slot}s. The definition schema already refused unknown slot names; a known slot with
 * no value here is left as written, so a missing value shows in the preview instead of vanishing.
 */
export const renderNotice = (text: string, slots: NoticeSlots) =>
  text.replace(/\{([^{}]*)\}/g, (whole, name: string) =>
    Object.hasOwn(slots, name) && slots[name as keyof NoticeSlots] !== undefined
      ? slots[name as keyof NoticeSlots]!
      : whole
  );

/** A UTC time as people read it in a notice: "20 November 2026, 16:05 UTC". */
export function noticeTime(d: Date) {
  const date = d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
  return `${date}, ${time} UTC`;
}
