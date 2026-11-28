// remix-app-creator template v1
const SPEC = {"icon":"pencil","engine":{"safe":{"ecosystem":"NanoBanana","versionId":3086021},"mature":{"ecosystem":"Qwen","versionId":2558804}},"asks":[{"id":"note","kind":"text","prompt":"Note \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz","maxLength":200,"optional":true,"wrap":{"before":"before \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz ","after":" after \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz"}},{"id":"mood","kind":"choice","prompt":"Mood \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz","options":[{"value":"calm","label":"Calm \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz","fragments":{"tone":"soft \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz"}},{"value":"bold","label":"Bold","fragments":{"tone":"hard \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz"}},{"value":"constructor","label":"Odd value","fragments":{"tone":"plain"}}]}],"steps":[{"kind":"image","prompt":"{{tone}} first \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz {{note}}{{tone}}","aspectRatio":"2:3","quantity":2,"input":"source"},{"kind":"image","prompt":"Again","aspectRatio":"source","quantity":1,"input":"previous"},{"kind":"upscale","scale":2}]};
export default defineRemixApp({
  async run(ctx) {
    const t0 = (await ctx.ask({ kind: "text", prompt: "Note \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz", maxLength: 200, optional: true })).trim();
    const c1 = await ctx.ask({ kind: "choice", prompt: "Mood \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz", options: [{"value":"calm","label":"Calm \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz"},{"value":"bold","label":"Bold"},{"value":"constructor","label":"Odd value"}] });
    const o1 = Math.max(0, ["calm","bold","constructor"].indexOf(c1));
    let images = [];
    ({ images } = await ctx.workflow({ kind: "image", prompt: ["soft \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz", "hard \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz", "plain"][o1] + " first \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz " + (t0 ? "before \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz " + t0 + " after \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz" : "") + ["soft \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz", "hard \"hi\" it's \\n \\ ${ctx.source} */ //\u2028x\u2029y\nz", "plain"][o1], images: [ctx.source], aspectRatio: "2:3", quantity: 2 }));
    ({ images } = await ctx.workflow({ kind: "image", prompt: "Again", images: [images[0]], aspectRatio: "source", quantity: 1 }));
    ({ images } = await ctx.workflow({ kind: "upscale", image: images[0], scale: 2 }));
    return images;
  },
});
