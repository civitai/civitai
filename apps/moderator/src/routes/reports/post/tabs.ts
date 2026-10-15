// The views of the open post, in the order the tabs render. Shared by the `[[tab=postTab]]` matcher,
// the load, which reads only the open tab's data, and the panel, which writes the path.
export const POST_TABS = ['images', 'details', 'owner'] as const;
export type PostTab = (typeof POST_TABS)[number];

export const POST_TAB_LABELS: Record<PostTab, string> = {
  images: 'Images',
  details: 'Post details',
  owner: "Owner's history",
};
