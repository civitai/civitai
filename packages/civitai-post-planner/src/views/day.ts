import type { TemplateResult } from 'lit';
import { renderHourGrid } from './hour-grid';
import type { ViewProps } from './index';

export function renderDay(props: ViewProps): TemplateResult {
  return renderHourGrid({
    dayKeys: [props.loc.anchor],
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
