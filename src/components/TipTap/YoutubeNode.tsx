import Youtube from '@tiptap/extension-youtube';

export const YoutubeNode = Youtube.configure({
  addPasteHandler: false,
  modestBranding: false,
});
