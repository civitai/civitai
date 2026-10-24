import type { TemplateResult } from 'lit';
import { weekDays } from '../model/calendar';
import { renderHourGrid } from './hour-grid';
import type { ViewProps } from './index';

export function renderWeek(props: ViewProps): TemplateResult {
  return renderHourGrid({
    dayKeys: weekDays(props.loc.anchor, props.today).map((d) => d.key),
    today: props.today,
    now: props.now,
    posts: props.posts,
    cap: props.cap,
    allHours: props.allHours,
    dragOver: props.dragOver,
    dragAt: props.dragAt,
    context: props.context,
  });
}
