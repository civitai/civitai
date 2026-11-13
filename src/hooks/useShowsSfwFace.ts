import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { showsSfwFace } from '~/shared/utils/model-sfw-face';

/** Whether this viewer gets a model's .com face; server responses already arrive resolved. */
export function useShowsSfwFace() {
  return showsSfwFace(useBrowsingLevelDebounced());
}
