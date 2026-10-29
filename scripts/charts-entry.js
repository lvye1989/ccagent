// Browser-only source. All dependencies are bundled into dist/charts.js.
import { init, use, registerMap } from "echarts/core";
import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import { AriaComponent, DataZoomComponent, GeoComponent, GridComponent, LegendComponent, ToolboxComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import land from "../web/world-land.json";
use([BarChart, LineChart, PieChart, ScatterChart, AriaComponent, DataZoomComponent, GeoComponent, GridComponent, LegendComponent, ToolboxComponent, TooltipComponent, SVGRenderer]);
registerMap("ccagent-land", { ...land, features: land.features.map((f, i) => ({ ...f, properties: { name: `Land ${i}` } })) });
export { init };
