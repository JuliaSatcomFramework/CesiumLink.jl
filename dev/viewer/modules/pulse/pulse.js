// A travelling pulse for an edge line, added to the set the vendored `primitives` module draws
// from.
//
// This module draws nothing of its own and owns no entity. It calls one function on `primitives`,
// and that is the whole module: `primitives` resolves an edge `style` it does not recognise as a
// stock name against the set registered here.
//
// The name is `pulse.travelling`. The token before the dot is this module's id, which is what makes
// the name an owner's rather than a stock one. A stock name never holds a dot.

// The name the Julia side writes as its `style`. Both halves spell it, and the two must move
// together.
const NAME = "pulse.travelling";

// One Cesium material per distinct appearance of the family. `primitives` owns what this answers
// with and destroys it when the appearance goes out of use, so answer a fresh material every call.
//
// `look.color` is the colour of that appearance and `look.dashLength` the family's dash period. A
// factory reads what it needs of them and ignores the rest.
const travelling = (C, look) =>
  new C.Material({
    translucent: true,
    fabric: {
      // The type names the shader in Cesium's own cache, so every material this factory builds
      // compiles one program and the collection buckets them together.
      type: "CesiumLinkTravellingPulse",
      uniforms: { color: look.color },
      // `materialInput.s` runs from 0 at one end of the line to 1 at the other, and
      // `czm_frameNumber` counts the frames the viewer has drawn. So the bright band walks along
      // the line with no uniform written per frame and nothing asked of the server.
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material material = czm_getDefaultMaterial(materialInput);
          float t = fract(materialInput.s - czm_frameNumber * 0.004);
          float pulse = smoothstep(0.0, 0.15, t) - smoothstep(0.15, 0.35, t);
          material.diffuse = color.rgb;
          material.alpha = color.a * (0.2 + 0.8 * pulse);
          return material;
        }`,
    },
  });

export default {
  setup(ctx) {
    // The scene registers `primitives` before this module, so `primitives` has run its own setup by
    // now and its exports are live. A module declared ahead of the one it extends reaches it too
    // early, and the Core says so.
    ctx.modules.get("primitives").defineEdgeMaterial(NAME, travelling);
    // Nothing to take down: the registry empties when `primitives` unloads, and this module unloads
    // with it.
  },
};
