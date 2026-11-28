// remix-app-creator template v1
const SPEC = {"icon":"grid","engine":{"safe":{"ecosystem":"NanoBanana","versionId":3086021},"mature":{"ecosystem":"Qwen","versionId":2558804}},"asks":[],"steps":[{"kind":"image","prompt":"Redraw this image as true low-resolution pixel art, as if drawn on a 160 by 240 pixel grid and scaled up with nearest-neighbor: large, clearly visible square pixels, hard stair-stepped edges, no anti-aliasing or smooth gradients, and a limited palette of about 16 flat colors with simple dithering. Keep the subject, pose and composition. Don't add any text or lettering.","aspectRatio":"source","quantity":1,"input":"source"}]};
export default defineRemixApp({
  async run(ctx) {
    let images = [];
    ({ images } = await ctx.workflow({ kind: "image", prompt: "Redraw this image as true low-resolution pixel art, as if drawn on a 160 by 240 pixel grid and scaled up with nearest-neighbor: large, clearly visible square pixels, hard stair-stepped edges, no anti-aliasing or smooth gradients, and a limited palette of about 16 flat colors with simple dithering. Keep the subject, pose and composition. Don't add any text or lettering.", images: [ctx.source], aspectRatio: "source", quantity: 1 }));
    return images;
  },
});
