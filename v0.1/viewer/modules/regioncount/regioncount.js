// A chart of how many satellites stood above a region, drawn into a floating box the viewer hands
// over. `ui` owns the box, this module owns everything inside it, and neither reaches across.
//
// The chart library is a sibling file on the same mount: the Julia side copies the library and this
// file into one directory and registers the module from there, so this plain relative import
// resolves under `/modules/regioncount/`. A bare specifier would not — the browser has no import
// map, and there is no bundler here.
import Plotly from "./plotly-esm-min.mjs";

// The topic the Julia side answers a click on. Both sides name it, so the two move together.
const TOPIC = "counts";

// Every box this module fills, so one answer redraws all of them, and the last answer, so a box
// that is resized redraws without asking for it again.
const sites = new Set();
let latest = null;
// The keyframe the clock is on. The chart draws up to it, so it fills as the scene plays.
let cursor = -1;

const LAYOUT = {
  margin: { l: 42, r: 14, t: 26, b: 34 },
  paper_bgcolor: "rgba(0,0,0,0)",
  plot_bgcolor: "rgba(0,0,0,0)",
  font: { color: "#e8e8e8", size: 11 },
  showlegend: false,
  xaxis: { title: { text: "minutes" }, gridcolor: "#ffffff22", zeroline: false },
  yaxis: { title: { text: "satellites" }, gridcolor: "#ffffff22", rangemode: "tozero",
           zeroline: false },
};

const CONFIG = { displayModeBar: false, responsive: false };

const title = (text) => ({ text, font: { size: 12 }, x: 0, xanchor: "left" });

// Both axes are fixed from the whole answer rather than from what is drawn, so the chart fills a
// standing frame instead of rescaling under the reader on every keyframe.
const axes = () => ({
  xaxis: { ...LAYOUT.xaxis, range: [0, latest.x[latest.x.length - 1]] },
  yaxis: { ...LAYOUT.yaxis, range: [0, Math.max(...latest.y) + 1] },
});

const draw = (el) => {
  if (latest === null) {
    Plotly.react(el, [], { ...LAYOUT, title: title("Click Europe or Africa") }, CONFIG);
    return;
  }
  // Up to the keyframe on screen, and no further: what the chart shows and what the globe shows are
  // the same instant. A scrub back shortens it again, because the cut is read from the clock rather
  // than accumulated as the frames go by.
  const upto = cursor + 1;
  const trace = {
    x: latest.x.slice(0, upto),
    y: latest.y.slice(0, upto),
    type: "scatter",
    mode: "lines",
    line: { shape: "hv", color: "#4cc9f0", width: 2 },
    fill: "tozeroy",
    fillcolor: "#4cc9f033",
  };
  Plotly.react(el, [trace], { ...LAYOUT, ...axes(), title: title(`Above ${latest.region}`) }, CONFIG);
};

export default {
  setup(ctx) {
    // A late answer is still worth having: a click asks a question, and the answer is the answer
    // whenever it lands. So nothing here compares the sequence number against the click that asked.
    // Dropping a stale answer is the receiving module's own policy, and this module does not want it.
    const off = ctx.onCommand(TOPIC, (payload) => {
      // A decoded array is a view onto the frame it arrived in, and holding one holds that whole
      // frame. These are a few hundred numbers, so they are copied and the frame is let go.
      latest = {
        region: payload.region,
        x: Array.from(payload.minutes.data),
        y: Array.from(payload.counts.data),
      };
      for (const el of sites) draw(el);
    });
    // The chart follows the clock, not the wire. The answer carries one count per keyframe, indexed
    // by absolute keyframe, and this says which of them the scene has reached — so the chart is
    // right under playback, a pause, a scrub and a change of speed alike.
    const offKeyframe = ctx.onKeyframe((index) => {
      cursor = index;
      if (latest !== null) for (const el of sites) draw(el);
    });
    return () => {
      off();
      offKeyframe();
      for (const el of sites) Plotly.purge(el);
      sites.clear();
      latest = null;
      cursor = -1;
    };
  },
};

// `ui` calls this once per content site that names this module. The chart goes in an element of the
// module's own, so nothing about the box itself is touched.
export function mount(site) {
  const el = document.createElement("div");
  // A box nobody has resized still has the height its declaration gave it; the floor is what keeps
  // a chart visible in a box the user has pulled small.
  el.style.cssText = "width:100%;height:100%;min-height:200px";
  site.el.appendChild(el);
  sites.add(el);
  draw(el);
  return {
    resize() {
      Plotly.Plots.resize(el);
    },
    dispose() {
      sites.delete(el);
      Plotly.purge(el);
      el.remove();
    },
  };
}
