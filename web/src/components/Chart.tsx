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

    void Plotly.react(node, data as Plotly.Data[], themed, {
      displaylogo: false,
      responsive: true,
      // The stock bar is mostly noise for an engineering readout; keep the
      // controls that get used and drop the rest.
      modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d", "toggleSpikelines"],
    });

    return () => {
      Plotly.purge(node);
    };
  }, [data, layout, height, equalAspect, title]);

  return <div className="chart panel"><div ref={host} /></div>;
}
