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

/** A UTC time as people read it in a notice, US style: "November 20, 2026, 4:05 PM UTC". */
export function noticeTime(d: Date) {
  const date = d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return `${date}, ${time} UTC`;
}
