// The generic renderer: the reason a time-driven simulation view can ship no JavaScript at all. It
// draws three families — nodes, edges between two node families by index, and regular-polygon ground
// footprints — from payloads Julia builds, with positions interpolated per tick and everything else
// switched at the keyframe crossing.
//
// What it will not draw is as deliberate as what it will: geometry here is a pure function of a
// position and a few scalars, in a fixed set of stock materials and stock marker glyphs. Custom
// shaders, materials or textures, extruded or volumetric geometry, anything needing re-tessellation
// per frame, and anything whose shape depends on simulated state rather than on a position are what
// a module of your own is for.

import type { Cartesian3 } from "@cesium/engine";
import type { AnchorPosition } from "../../core/src/camera.ts";
import type { Disposable, ModuleContext } from "../../core/src/module-host.ts";
import { AreaFamily, type AreaSpec } from "./areas.ts";
import { EdgeFamily, type EdgeSpec, type EndpointFamily } from "./edges.ts";
import { NodeFamily, type NodeSpec } from "./nodes.ts";
import type { CesiumRuntime } from "./paint.ts";

/** One window's scene, as Julia's `primitives_payload` builds it. */
interface ScenePayload {
  nodes?: NodeSpec[];
  edges?: EdgeSpec[];
  areas?: AreaSpec[];
}

/**
 * What a peer may ask about an entity it draws something over: where it is, whether it is drawn, and
 * who it is. The two families that own entities both answer, and an edge does not — an edge is a line
 * between two of them, and this effort has no shape for a primitive anchored to a line.
 */
interface AnchorFamily extends EndpointFamily {
  pickIdAt(idx: number): object | undefined;
  shownAt(idx: number): boolean | undefined;
}

interface Live {
  /**
   * Where a kind sits, as one lookup rather than two: the very accessor an edge hangs its own
   * endpoints off, so an anchor and an endpoint can never disagree about a family's position.
   */
  endpoint: (kind: string) => AnchorFamily | undefined;
  edges: Map<string, EdgeFamily>;
  /** For the one position that is computed rather than held: an edge's midpoint. */
  C: CesiumRuntime;
}

// What the read-only accessors below reach. One viewer holds one instance of a module, so this is
// that instance's families; teardown clears it, and a lookup before setup or after unload finds
// nothing rather than a stale scene.
let live: Live | null = null;

export default {
  setup(ctx: ModuleContext): Disposable {
    const { Cesium, scene } = ctx;
    const nodes = new Map<string, NodeFamily>();
    const edges = new Map<string, EdgeFamily>();
    const areas = new Map<string, AreaFamily>();
    // What the Core's drill-pick reads to learn who owns a hit. A primitive without one is
    // decoration, and never masks a pickable underneath it.
    const pickId = (kind: string, idx: number) => ctx.pickId(kind, idx);

    // What an edge hangs off: a node family contributes its position, an area family its footprint
    // centre. One lookup for both, so a link from a ground cell to a satellite is one edge family
    // over one of each.
    const endpoint = (kind: string) => nodes.get(kind) ?? areas.get(kind);

    // Where absolute keyframe `index` sits is the Core's bookkeeping and the same for every family,
    // so it is resolved once here; each family then says only what it holds at that placement.
    const applyKeyframe = (index: number) => {
      const at = ctx.placement(index);
      for (const family of nodes.values()) family.onKeyframe(at);
      for (const family of areas.values()) family.onKeyframe(at);
      // Last: an edge is built against the node positions its endpoints are, so its families must
      // exist and be sized before it looks them up.
      for (const family of edges.values()) family.onKeyframe(at);
    };

    const disposables = [
      // One registration answers for every entity this module draws, however many there are: the
      // resolver reads a name on demand and nothing here enumerates what can be ridden.
      ctx.anchors(anchorFor),
      ctx.onWindow((w, payload) => {
        const p = (payload ?? {}) as ScenePayload;
        const replace = w.mode === "replace";
        if (replace) {
          // A replace may renumber, so a family this window does not name has no author left and
          // its entities are gone.
          prune(nodes, p.nodes);
          prune(edges, p.edges);
          prune(areas, p.areas);
        }
        for (const spec of p.nodes ?? []) {
          family(nodes, spec.kind,
                 () => new NodeFamily(spec.kind, Cesium, scene, pickId, ctx.perWindow()))
            .onWindow(spec, w);
        }
        for (const spec of p.areas ?? []) {
          family(areas, spec.kind,
                 () => new AreaFamily(spec.kind, Cesium, scene, pickId, ctx.perWindow()))
            .onWindow(spec, w);
        }
        for (const spec of p.edges ?? []) {
          family(edges, spec.kind,
                 () => new EdgeFamily(spec.kind, Cesium, scene, endpoint, pickId, ctx.perWindow()))
            .onWindow(spec, w);
        }
      }),
      ctx.onKeyframe(applyKeyframe),
      ctx.onFrame(({ index, alpha }) => {
        // Both ends of the blend resolved once: every node family interpolates across the same pair.
        const a = ctx.placement(index);
        const b = ctx.placement(index + 1);
        for (const f of nodes.values()) f.onFrame(a, b, alpha);
        // After the nodes: an edge's endpoints are their position objects, so it follows what they
        // were just moved to.
        for (const f of edges.values()) f.onFrame();
      }),
    ];

    live = { endpoint, edges, C: Cesium };
    return () => {
      for (const dispose of disposables) dispose();
      for (const f of nodes.values()) f.destroy();
      for (const f of edges.values()) f.destroy();
      for (const f of areas.values()) f.destroy();
      nodes.clear();
      edges.clear();
      areas.clear();
      live = null;
    };
  },
};

/**
 * Live position of entity `idx` in family `kind`, for a module drawing something coincident with it
 * — an anchored float above all. Resolved in one order, whatever kind of family owns the kind: a
 * node gives its position, an area the centre its footprint stands on, an edge the midpoint of the
 * link. The first two go through the same lookup an edge hangs its endpoints off, so an anchor and
 * an endpoint cannot disagree.
 *
 * Read live and, for an edge, computed per call, so what comes back follows the per-tick
 * interpolation instead of standing where some keyframe left it. A kind no family owns, an index a
 * family does not have, and an edge missing either end all resolve to nothing.
 */
export function positionOf(kind: string, idx: number): Cartesian3 | undefined {
  if (!live) return undefined;
  const at = live.endpoint(kind)?.positions[idx];
  if (at) return at;
  const ends = edgeEndpoints(kind, idx);
  // A fresh vector rather than a scratch: this is a public accessor, and a caller holding what it
  // was handed must not have it moved under them by the next call.
  return ends && live.C.Cartesian3.midpoint(ends[0], ends[1], new live.C.Cartesian3());
}

/**
 * How many entities family `kind` holds, for a module drawing one primitive per entity of it. A
 * model family stands on a node family and carries no positions of its own, so this is the only
 * thing that says how many models to build; deriving it from an optional knob leaves the family
 * that declares none with no count at all, and probing `positionOf` until it answers nothing is the
 * same number reached by inference.
 *
 * Answers for the two families that own entities, node and area. An edge family owns none — it is a
 * line between two of them — and a kind no family owns answers nothing, which is not the same as
 * zero: a family that exists and is empty is a family whose window said so.
 *
 * Read it per window, not once: a replacing window may resize the family under you.
 */
export function countOf(kind: string): number | undefined {
  return live?.endpoint(kind)?.positions.length;
}

/** Live interpolated endpoints of an edge, for drawing something coincident with it. */
export function edgeEndpoints(kind: string, idx: number): [Cartesian3, Cartesian3] | undefined {
  return live?.edges.get(kind)?.endpointsOf(idx);
}

/** The endpoint pairs of an edge family, as delivered for the keyframe on screen. */
export function pairsOf(kind: string): { from: string; to: string; pairs: Uint32Array } | undefined {
  return live?.edges.get(kind)?.connectivity();
}

/**
 * The pick stamp of entity `idx` in family `kind`, for a module drawing something anchored to it —
 * a sensor cone over a satellite, a glTF model, a coverage volume. Set it as your primitive's `id`
 * and a click on what you drew reports **the satellite**, in this module's namespace, as though what
 * you drew did not exist. A listener written for the marker fires and never learns of it.
 *
 * The stamp is opaque. Set it and read nothing out of it: what is inside belongs to the Core, and a
 * stamp you mint rather than borrow speaks for an entity whose owner never offered it.
 *
 * Where an entity is drawn through the entity API its primitives' `id` is Cesium's own `Entity`, so
 * the stamp cannot go there. Hang it on that object's `pickId` property instead — the Core reads
 * that one step, and `docs/module-api.md` states it as contract.
 *
 * Expect `undefined` on any frame, not only for a kind no family owns and an index a family does not
 * have: a replacing window prunes the family you are anchored to, and it does so under you.
 */
export function pickIdOf(kind: string, idx: number): object | undefined {
  return live?.endpoint(kind)?.pickIdAt(idx);
}

/**
 * Whether entity `idx` in family `kind` is drawn, so an anchored primitive hides with it. A masked
 * entity keeps its index and is not pickable, so a cone left drawn over one is a shape reporting an
 * entity nothing on screen shows.
 */
export function showOf(kind: string, idx: number): boolean | undefined {
  return live?.endpoint(kind)?.shownAt(idx);
}

// There is deliberately no setter here, and the accessors above do not become one. A module may read
// where an entity is, whether it is drawn, and who it is; it may never restyle or mutate it, and it
// may never mint an identity this module did not offer. A viewer-side mutation has no author on the
// server, so the next window silently overwrites it — one owner per entity, and writes never cross a
// module boundary.

/**
 * How a camera viewpoint names an entity of this module to ride: one kind and one index, written
 * `sat[7]`. The Core never reads this string, so the spelling is this module's own.
 *
 * **The index counts from 1.** The author who writes this string is the author who reads a pointer
 * event. A Julia listener gets `ev.entity.idx` through `from_wire_index`
 * (`src/codec.jl`), which already counts from 1, so `"sat[$(ev.entity.idx)]"` names
 * the entity the user clicked. Every accessor above counts from 0. The two bases meet here and
 * nowhere else.
 *
 * The answer is a getter, never a position. A replacing window rebuilds a family under the camera,
 * and a vector resolved once then stands where the family left it.
 *
 * An edge resolves like anything else, so a camera can ride the middle of a link.
 */
function anchorFor(target: string): AnchorPosition | null {
  const named = /^([^[\]]+)\[(\d+)\]$/.exec(target);
  if (!named) return null;
  const kind = named[1];
  const idx = Number(named[2]) - 1;
  const at: AnchorPosition = () => positionOf(kind, idx) ?? null;
  // A name nothing answers for is a name this module does not know: the Core logs one line and the
  // camera stands still. A family that goes away later is the getter's own answer, not this one.
  return idx >= 0 && at() ? at : null;
}

function family<T>(into: Map<string, T>, kind: string, make: () => T): T {
  let one = into.get(kind);
  if (!one) into.set(kind, (one = make()));
  return one;
}

function prune<T extends { destroy(): void }>(from: Map<string, T>, specs?: { kind: string }[]): void {
  const named = new Set((specs ?? []).map((s) => s.kind));
  for (const [kind, one] of from) {
    if (named.has(kind)) continue;
    one.destroy();
    from.delete(kind);
  }
}
