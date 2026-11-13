/**
 * The two top-level `/apps` destinations.
 *
 * `/apps` is the signed-in viewer's app HOME ("My apps": a launcher for the apps they
 * have). The MARKETPLACE — where you go to get new apps — lives at `/apps/store`. Before
 * the split, `/apps` was the marketplace, so `/apps?category=…` style links still arrive
 * there and are redirected to the store with their query (`resolveAppsHomeAccess`).
 *
 * Link to the store through `APPS_STORE_HREF`, never a hand-typed `'/apps'`: that string
 * now means the home, and every "browse the marketplace" link that kept it would land a
 * signed-in viewer on their own launcher instead.
 */
export const APPS_HOME_HREF = '/apps';
export const APPS_STORE_HREF = '/apps/store';
