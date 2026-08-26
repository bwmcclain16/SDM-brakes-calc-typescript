/** Plotly wrapper carrying the Helios chart theme.
 *
 * Every chart in the app goes through here so grid, axis, font and trace colours
 * are set once rather than per call site. That was a real problem in the
 * Streamlit version: appearance controls existed on only 3 of 15 pages, so most
 * charts silently ignored them.
 *
 * plotly.js is the same engine the Python app used through plotly.py, so figures
 * translate directly — only the convenience wrappers (px.line, px.imshow) are
 * Python-only and become explicit trace objects here.
 */
import { useEffect, useRef } from "react";
import Plotly from "plotly.js-dist-min";

/** Helios' 12-colour trace palette, tuned for dark backgrounds. */
export const TRACE_COLORS = [
  "#FFB800", "#4FC3F7", "#66BB6A", "#FF8A65",
  "#BA68C8", "#9CCC65", "#26A69A", "#EF5350",
  "#5C6BC0", "#FFCA28", "#26C6DA", "#AB47BC",
] as const;

/** Black-body ramp for temperature fields — what a hot rotor actually looks like. */
export const HEAT_SCALE: Array<[number, string]> = [
  [0, "#000004"], [0.25, "#7e0303"], [0.5, "#e34a00"], [0.75, "#f7d000"], [1, "#ffffff"],
];

const FONT = {
  family: 'Inter, system-ui, sans-serif',
  size: 11,
  color: "#7B8088",
};

/** Purge a figure only once nothing is still drawing it.
 *
 * Plotly finishes every draw by reading `gd._fullLayout`, and a `responsive`
 * figure starts draws we never asked for — its ResizeObserver relayouts when a
 * sibling chart appears or disappears. Purging synchronously on unmount can
 * therefore land in the middle of a pipeline we do not hold a promise for, and
 * Plotly then dereferences a layout it has already dropped. Waiting for the
 * last draw we DID start and then two frames lets those in-flight relayouts
 * finish first; the figure is off-screen by then, so the delay costs nothing.
 */
function purgeWhenIdle(node: HTMLElement, drawn: Promise<unknown>): void {
  const purge = () =>
    requestAnimationFrame(() => requestAnimationFrame(() => Plotly.purge(node)));
  void drawn.then(purge, purge);
}

export interface ChartProps {
  data: Partial<Plotly.PlotData>[];
  layout?: Partial<Plotly.Layout>;
  height?: number;
  /** Lock the y-axis to the x-axis scale — for anything drawn in real geometry
   *  (rotor faces, section outlines) where distorting the aspect ratio lies. */
  equalAspect?: boolean;
  title?: string;
}

export function Chart({ data, layout = {}, height = 320, equalAspect, title }: ChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const pending = useRef<Promise<unknown>>(Promise.resolve());

  // Teardown is deliberately NOT part of the draw effect. `Plotly.react` is an
  // in-place update, so re-drawing on new data must not purge first.
  useEffect(() => {
    const node = host.current;
    return () => {
      if (node) purgeWhenIdle(node, pending.current);
    };
  }, []);

  useEffect(() => {
    const node = host.current;
    if (!node) return;

    const themed: Partial<Plotly.Layout> = {
      height,
      margin: { l: 56, r: 16, t: title ? 34 : 12, b: 44 },
      paper_bgcolor: "#16171B",
      plot_bgcolor: "#0E0E10",
      font: FONT,
      colorway: [...TRACE_COLORS],
      title: title ? { text: title, font: { ...FONT, size: 12.5, color: "#D8DCE2" } } : undefined,
      showlegend: data.length > 1,
      legend: { font: FONT, orientation: "h", y: -0.2 },
      ...layout,
      xaxis: {
        gridcolor: "#23252B", zerolinecolor: "#2A2C32", linecolor: "#5A5F66",
        tickfont: FONT, ...(layout.xaxis ?? {}),
      },
      yaxis: {
        gridcolor: "#23252B", zerolinecolor: "#2A2C32", linecolor: "#5A5F66",
        tickfont: FONT,
        ...(equalAspect ? { scaleanchor: "x" as const, scaleratio: 1 } : {}),
        ...(layout.yaxis ?? {}),
      },
    };

    pending.current = Plotly.react(node, data as Plotly.Data[], themed, {
      displaylogo: false,
      responsive: true,
      // The stock bar is mostly noise for an engineering readout; keep the
      // controls that get used and drop the rest.
      modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d", "toggleSpikelines"],
    });
  }, [data, layout, height, equalAspect, title]);

  return <div className="chart panel"><div ref={host} /></div>;
}

// --- animation ----------------------------------------------------------------

export interface AnimFrame {
  /** Slider label — the frame's real run time, not an index. */
  label: string;
  data: Partial<Plotly.PlotData>[];
  /** Trace indices each frame datum replaces. Omit to replace all traces. */
  traces?: number[];
  title?: string;
}

export interface AnimatedChartProps extends ChartProps {
  frames: AnimFrame[];
  /** Milliseconds per frame. */
  frameMs?: number;
}

/** A chart with Plotly's own play/stop controls and a time slider.
 *
 * Frames go through Plotly's animation machinery rather than a React state
 * loop: re-rendering a 241x241 heatmap through `Plotly.react` on every tick
 * repaints the whole figure, while `Plotly.animate` swaps only the frame's
 * own data. The slider is labelled with real run time — a frame index tells
 * the reader nothing about where in the stop they are.
 */
export function AnimatedChart({
  data,
  frames,
  layout = {},
  height = 420,
  equalAspect,
  title,
  frameMs = 120,
}: AnimatedChartProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let disposed = false;

    const play = {
      label: "Play",
      method: "animate" as const,
      args: [
        null,
        {
          frame: { duration: frameMs, redraw: true },
          fromcurrent: true,
          transition: { duration: 0 },
        },
      ],
    };
    const stop = {
      label: "Stop",
      method: "animate" as const,
      args: [
        [null],
        { frame: { duration: 0, redraw: false }, mode: "immediate", transition: { duration: 0 } },
      ],
    };

    const themed: Partial<Plotly.Layout> = {
      height,
      margin: { l: 56, r: 16, t: title ? 34 : 12, b: 92 },
      paper_bgcolor: "#16171B",
      plot_bgcolor: "#0E0E10",
      font: FONT,
      colorway: [...TRACE_COLORS],
      title: title ? { text: title, font: { ...FONT, size: 12.5, color: "#D8DCE2" } } : undefined,
      showlegend: data.length > 1,
      legend: { font: FONT, orientation: "h", y: -0.34 },
      ...layout,
      xaxis: {
        gridcolor: "#23252B", zerolinecolor: "#2A2C32", linecolor: "#5A5F66",
        tickfont: FONT, ...(layout.xaxis ?? {}),
      },
      yaxis: {
        gridcolor: "#23252B", zerolinecolor: "#2A2C32", linecolor: "#5A5F66",
        tickfont: FONT,
        ...(equalAspect ? { scaleanchor: "x" as const, scaleratio: 1 } : {}),
        ...(layout.yaxis ?? {}),
      },
      updatemenus: [
        {
          type: "buttons", showactive: false, direction: "left",
          x: 0.1, y: 0, xanchor: "right", yanchor: "top",
          pad: { r: 10, t: 74 },
          bgcolor: "#16171B", bordercolor: "#2A2C32",
          font: { ...FONT, color: "#D8DCE2" },
          buttons: [play, stop],
        },
      ] as never,
      sliders: [
        {
          x: 0.1, y: 0, xanchor: "left", yanchor: "top",
          len: 0.9, pad: { b: 10, t: 64 },
          currentvalue: { prefix: "Run time: ", font: { ...FONT, color: "#D8DCE2" } },
          font: FONT,
          bgcolor: "#2A2C32", bordercolor: "#2A2C32", activebgcolor: "#FFC627",
          steps: frames.map((frame) => ({
            label: frame.label,
            method: "animate",
            args: [
              [frame.label],
              { mode: "immediate", frame: { duration: 0, redraw: true }, transition: { duration: 0 } },
            ],
          })),
        },
      ] as never,
    };

    const drawn = Plotly.newPlot(node, data as Plotly.Data[], themed, {
      displaylogo: false,
      responsive: true,
      modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d", "toggleSpikelines"],
    }).then(() => {
      if (disposed) return;
      return Plotly.addFrames(
        node,
        frames.map((frame) => ({
          name: frame.label,
          data: frame.data as Plotly.Data[],
          traces: frame.traces,
          ...(frame.title ? { layout: { title: { text: frame.title } } } : {}),
        })) as never,
      );
    });

    return () => {
      disposed = true;
      purgeWhenIdle(node, drawn);
    };
  }, [data, frames, layout, height, equalAspect, title, frameMs]);

  return <div className="chart panel"><div ref={host} /></div>;
}
