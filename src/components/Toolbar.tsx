import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { tx } from "@twind/core";
import { Saturation, Hue, hexToHsva, hsvaToHex } from "@uiw/react-color";
import { normalizeColor } from "../utils/color";

export type ToolMode =
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "pen"
  | "text"
  | "bucket"
  | "selection";
export type FillMode = "stroke" | "fill";
export type TextSize = "small" | "medium" | "large";

// ---------- Pickers' options ----------

const COLORS = ["#000000", "#10aeff", "#91d300", "#ffc300", "#fa5151", "#8b5cf6", "#ffffff"];
const LINE_WIDTHS = [2, 4, 8, 12];
const TEXT_SIZE_TO_PX: Record<TextSize, number> = { small: 16, medium: 24, large: 36 };
const TEXT_SIZE_LABEL: Record<TextSize, string> = { small: "小", medium: "中", large: "大" };

// Tools are split into two visual groups separated by a divider.
// Primary (pen / text) sits first; shapes group (bucket / rect / ellipse / line / arrow / selection) second.
const PRIMARY_TOOLS: ToolMode[] = ["pen", "text"];
const SHAPE_TOOLS: ToolMode[] = ["bucket", "rect", "ellipse", "line", "arrow", "selection"];

// ---------- Icons ----------
// SVG path data mirrored from src/assets/*.svg. Inlining (instead of importing
// the .svg files) lets us drive the color via `fill="currentColor"`, so
// button hover / active states automatically re-color the glyph. All icons
// share viewBox 0 0 1024 1024 and 18×18 size for visual consistency.

const IconRect = () => (
  <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
    <path d="M881.2 961.3H136c-42.2 0-76.5-34.3-76.5-76.5V139.5C59.5 97.3 93.8 63 136 63h745.2c42.2 0 76.5 34.3 76.5 76.5v745.2c0.1 42.2-34.3 76.6-76.5 76.6zM136 109.6c-16.5 0-29.9 13.4-29.9 29.9v745.2c0 16.5 13.4 29.9 29.9 29.9h745.2c16.5 0 29.9-13.4 29.9-29.9V139.5c0-16.5-13.4-29.9-29.9-29.9H136z" />
  </svg>
);
const IconEllipse = () => (
  <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
    <path d="M512 42.666667C252.793333 42.666667 42.666667 252.793333 42.666667 512s210.126667 469.333333 469.333333 469.333333 469.333333-210.126667 469.333333-469.333333S771.206667 42.666667 512 42.666667z m0 896c-235.64 0-426.666667-191.026667-426.666667-426.666667s191.026667-426.666667 426.666667-426.666667 426.666667 191.026667 426.666667 426.666667-191.026667 426.666667-426.666667 426.666667z" />
  </svg>
);
const IconArrow = () => (
  <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
    <path d="M768 256H353.984a31.168 31.168 0 0 1-23.04-8.96 31.168 31.168 0 0 1-8.96-23.04c0-9.344 3.008-17.024 8.96-23.04a31.168 31.168 0 0 1 23.04-8.96H800c9.344 0 17.024 3.008 23.04 8.96 5.952 6.016 8.96 13.696 8.96 23.04v448a31.168 31.168 0 0 1-8.96 23.04 31.168 31.168 0 0 1-23.04 8.96 31.168 31.168 0 0 1-23.04-8.96 31.168 31.168 0 0 1-8.96-23.04V256z m8.96-55.04A33.408 33.408 0 0 1 800 192a30.72 30.72 0 0 1 22.464 9.472A30.72 30.72 0 0 1 832 224a33.408 33.408 0 0 1-8.96 23.04l-544 544a33.408 33.408 0 0 1-23.04 8.96 30.72 30.72 0 0 1-22.528-9.536A30.72 30.72 0 0 1 224 768c0-8.64 3.008-16.32 8.96-23.04l544-544z" />
  </svg>
);
const IconLine = () => (
  <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
    <path d="M191.488 864.768c-8.192 0-16.384-3.072-22.528-9.216-12.288-12.288-12.288-32.768 0-45.056L809.472 168.96c12.288-12.288 32.768-12.288 45.056 0s12.288 32.768 0 45.056L214.016 855.04c-6.144 6.144-14.336 9.728-22.528 9.728z" />
  </svg>
);
const IconPen = () => (
  <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
    <path d="M635.008 92.629333a170.666667 170.666667 0 0 1 241.365333 0l75.008 75.008a170.666667 170.666667 0 0 1 0 241.365334l-80.213333 80.128-499.626667 499.712a42.666667 42.666667 0 0 1-31.744 12.501333l-247.04-9.045333a42.666667 42.666667 0 0 1-41.045333-41.088L42.666667 704.256a42.666667 42.666667 0 0 1 12.458666-31.744L554.837333 172.8a43.52 43.52 0 0 1 0.384-0.341333z m-50.005333 170.709334L128.64 719.701333l6.869333 188.714667 188.8 6.912 456.32-456.362667-195.626666-195.626666z m230.997333-110.336a85.333333 85.333333 0 0 0-120.618667 0l-50.048 49.962666 195.669334 195.669334 50.005333-50.005334a85.333333 85.333333 0 0 0 4.992-115.2l-4.992-5.418666z" />
  </svg>
);
const IconText = () => (
  <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
    <path d="M554.666667 256v640h-85.333334V256H213.333333V170.666667h597.333334v85.333333h-256z" />
  </svg>
);
const IconUndo = () => (
  <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
    <path d="M129.4336 502.8864l267.776 289.9456v-146.3808l26.7776-31.5904c77.6192-12.6976 158.72-9.8304 243.2 8.0896 69.3248 14.6944 142.2336 63.488 218.7264 141.1072a528.9984 528.9984 0 0 0-134.144-229.5808l20.8384-20.5824-20.7872 20.5824c-88.8832-90.0608-195.8912-135.2704-322.9184-136.2432l-31.744-32v-138.24l-267.776 274.8928z m-67.072-22.9376L406.272 126.976l54.9376 22.3744v185.9584c130.3552 8.0384 242.8928 59.648 336.1792 154.2144 100.352 101.6832 157.9008 228.352 173.1584 378.368l-56.6272 23.552c-103.6288-126.464-190.3104-191.1296-259.9424-205.8752-67.584-14.336-131.7888-17.9712-192.768-11.2128v200.2944l-55.5008 21.7088-343.8592-372.3776 0.6144-44.032z" />
  </svg>
);
const IconRedo = () => (
  <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
    <path d="M894.5664 502.8864l-267.776 289.9456v-146.3808l-26.8288-31.5904c-77.568-12.6976-158.72-9.8304-243.2 8.0896-69.3248 14.6944-142.1824 63.488-218.7264 141.1072a528.9984 528.9984 0 0 1 134.144-229.5808l-20.8384-20.5824 20.8384 20.5824c88.8832-90.0608 195.8912-135.2192 322.8672-136.2432l31.744-32v-138.24l267.776 274.8928z m67.0208-22.9376l-343.8592-352.9216-54.9376 22.3232v185.9584c-130.304 8.0896-242.8416 59.648-336.1792 154.2144-100.352 101.6832-157.9008 228.352-173.1072 378.4192l56.576 23.552c103.6288-126.5664 190.3616-191.1808 259.9936-205.9264 67.584-14.336 131.7888-17.9712 192.7168-11.2128v200.2944l55.552 21.7088 343.8592-372.3776-0.6144-44.032z" />
  </svg>
);
const IconBucket = () => (
  <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
    <path d="M662.94 130.133l-52.46-52.437c-46.229-46.72-129.493-46.72-175.7 0l-312.32 315.05c-36.118 36.48-45.953 89.323-28.971 133.334l-5.227 9.408c-2.859 5.184-7.68 14.293-13.803 26.56-10.112 20.31-20.224 42.24-29.674 65.067a738.112 738.112 0 0 0-30.635 87.85C-0.74 769.664-4.687 816.512 6.513 854.912c15.53 53.141 58.965 83.755 122.432 83.755 63.701 0 106.986-30.912 121.6-84.523 10.453-38.443 5.589-85.248-10.368-139.925-3.755-12.864-8.107-26.027-12.971-39.403l268.245 270.635c24.171 24.426 54.379 35.882 89.536 35.882 31.83 0 60.459-12.053 86.187-32.853l3.35-3.03 312.32-315.05c49.663-50.133 49.663-131.307-0.129-176.512L723.27 190.464l74.965-74.965a42.667 42.667 0 0 0-60.33-60.331l-74.966 74.965z m0.98 119.68l262.977 262.87c16.042 14.592 16.042 42.069-1.536 59.797L617.883 882.645C606.278 891.648 595.441 896 584.753 896c-14.166 0-23.36-3.477-31.446-11.648l-370.73-373.888c-16.043-14.592-16.043-42.07 1.536-59.819l309.184-311.85c14.272-14.422 45.269-14.422 59.69 0.149l50.56 50.56-121.664 121.664a42.667 42.667 0 0 0 60.331 60.33l121.685-121.685zM123.59 659.584a893.867 893.867 0 0 1 2.773-6.635 818.32 818.32 0 0 1 3.947 8.96 664.512 664.512 0 0 1 27.968 76.075c11.947 40.981 15.381 73.877 9.941 93.888-4.224 15.467-13.013 21.76-39.274 21.76-45.526 0-55.168-33.024-32.47-116.395 6.614-24.362 15.894-50.56 27.115-77.653z" />
  </svg>
);
const IconSelectBox = () => (
  <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
    <path d="M429.8 890.7h-77.2v-38.2h77.2v38.2z m-154.4 0h-77.2v-38.2h77.2v38.2zM121 890.7H63.7v-57.2h38.2v19.1H121zM101.9 756.3H63.7v-77.2h38.2v77.2z m0-154.4H63.7v-77.2h38.2v77.2z m0-154.4H63.7v-77.2h38.2v77.2z m0-154.4H63.7v-77.2h38.2v77.2zM101.9 138.7H63.7V81.5H121v38.2h-19.1zM738.5 119.7h-77.2V81.5h77.2v38.2z m-154.4 0H507V81.5h77.2v38.2z m-154.3 0h-77.2V81.5h77.2v38.2z m-154.4 0h-77.2V81.5h77.2v38.2zM873 138.7h-38.2v-19h-19.1V81.5H873zM873 447.5h-38.2v-77.2H873v77.2z m0-154.4h-38.2v-77.2H873v77.2z" />
    <path d="M835.2 947.1c-0.8 0-1.5 0-2.3-0.1-4.7-0.6-9.1-3.1-12-6.8l-128.5-166-58.8 45.5c-4.8 3.7-11.2 4.8-17 2.8-5.8-2-10.1-6.8-11.6-12.7L523.1 476c-1.7-6.9 0.8-14.2 6.5-18.6 5.6-4.4 13.3-5 19.6-1.6L852 618.5c5.4 2.9 8.9 8.3 9.4 14.4s-2.1 12-6.9 15.7l-58.8 45.5 128.5 166c6.1 7.9 4.7 19.2-3.2 25.3l-74.7 57.9c-3.2 2.5-7.1 3.8-11.1 3.8zM695.7 730.8c5.4 0 10.7 2.4 14.3 7l128.5 166 46.2-35.8-128.5-166c-2.9-3.8-4.2-8.6-3.6-13.3s3.1-9.1 6.8-12l51.1-39.6-242.6-130.5 65.6 267.5 51.1-39.6c3.3-2.5 7.2-3.7 11.1-3.7z" />
  </svg>
);
const IconClear = () => (
  <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
    <path d="M274.56 798.997333l19.434667-25.130666-33.792 68.565333a18.133333 18.133333 0 0 0 11.562666 25.536l59.733334 16a18.133333 18.133333 0 0 0 17.28-4.48c20.522667-19.818667 35.626667-35.989333 45.290666-48.469333l19.456-25.130667-33.813333 68.565333a18.133333 18.133333 0 0 0 11.562667 25.536l84.48 22.634667a18.133333 18.133333 0 0 0 17.28-4.48c20.522667-19.84 35.626667-35.989333 45.269333-48.469333l19.456-25.130667-33.813333 68.565333A18.133333 18.133333 0 0 0 535.530667 938.666667l72.106666 19.328a18.133333 18.133333 0 0 0 17.28-4.48c20.522667-19.84 35.626667-36.010667 45.269334-48.490667l19.456-25.130667-33.813334 68.586667a18.133333 18.133333 0 0 0 11.584 25.514667l86.421334 23.338666 3.84-0.213333c13.269333-0.704 29.056-5.034667 43.84-12.8 29.781333-15.701333 48.170667-43.2 52.181333-78.250667 2.133333-18.517333 4.778667-38.549333 8.405333-63.530666 1.642667-11.221333 2.944-20.010667 6.229334-41.834667 11.050667-73.322667 14.634667-101.034667 17.130666-133.674667l0.938667-12.373333 2.837333-2.922667 12.330667-1.344a41.813333 41.813333 0 0 0 24.810667-11.221333c10.730667-10.24 14.805333-25.386667 11.093333-42.197333l-37.546667-171.584c-3.029333-13.696-11.264-27.946667-23.146666-39.829334-11.648-11.626667-25.92-20.138667-39.893334-23.893333L723.626667 331.306667l-2.261334-3.925334L774.250667 130.133333c8.32-31.061333-11.754667-63.744-44.970667-72.64l-79.509333-21.312c-33.194667-8.896-66.922667 9.365333-75.264 40.426667l-52.842667 197.269333-3.925333 2.261334-118.101334-31.637334c-13.994667-3.754667-30.634667-3.498667-46.506666 0.746667-16.256 4.352-30.506667 12.586667-39.957334 22.933333l-118.314666 129.792c-11.605333 12.714667-15.658667 27.84-11.52 42.090667 4.16 14.229333 15.850667 25.194667 32.896 30.528l13.610666 4.266667 2.133334 3.882666-3.626667 13.802667c-21.12 79.850667-52.885333 136.917333-85.717333 150.890667-47.530667 20.202667-72.938667 49.429333-78.421334 85.034666-5.034667 32.682667 9.28 67.114667 37.589334 91.541334l22.037333 8.341333 74.666667 20.010667a42.666667 42.666667 0 0 0 41.216-11.050667c15.274667-15.274667 26.88-28.032 34.837333-38.293333z m551.381333-396.565333c14.144 3.797333 29.952 19.2 32.768 32l34.56 157.781333a10.666667 10.666667 0 0 1-13.184 12.586667L240.64 433.493333a10.666667 10.666667 0 0 1-5.12-17.493333l108.8-119.36c8.832-9.685333 30.229333-15.146667 44.373333-11.349333l141.333334 37.866666a21.333333 21.333333 0 0 0 26.133333-15.082666l58.304-217.642667a21.333333 21.333333 0 0 1 26.133333-15.082667l77.056 20.650667a21.333333 21.333333 0 0 1 15.082667 26.133333l-58.325333 217.642667a21.333333 21.333333 0 0 0 15.082666 26.112l136.448 36.565333zM315.456 701.568c-33.664 45.141333-64.597333 79.082667-92.8 101.802667l-5.909333 4.778666-2.837334 0.597334-88.106666-24.106667-2.922667-3.2c-13.034667-14.165333-19.370667-31.04-16.981333-46.592 3.285333-21.333333 22.058667-39.338667 53.205333-52.586667 31.722667-13.482667 59.818667-47.104 82.922667-99.904 10.026667-22.954667 18.88-48.725333 26.389333-76.586666l3.882667-14.4 3.904-2.261334 566.165333 151.701334 2.346667 3.306666-0.789334 12.224c-1.984 30.592-30.336 229.397333-32.128 244.906667-2.346667 20.416-11.306667 34.986667-27.605333 44.394667a73.237333 73.237333 0 0 1-21.397333 8.106666l-5.013334 0.725334-60.373333-16.170667 11.242667-20.288c8.277333-14.976 22.656-43.84 43.093333-86.613333a21.12 21.12 0 0 0-9.962667-28.16l-3.136-1.493334a21.333333 21.333333 0 0 0-26.261333 6.485334c-33.642667 45.056-64.533333 78.912-92.672 101.546666l-5.909333 4.757334-2.837334 0.597333-52.544-14.08 11.114667-20.266667c3.562667-6.485333 7.04-13.013333 10.453333-19.626666 7.04-13.504 17.898667-35.797333 32.597334-66.816a21.290667 21.290667 0 0 0-9.984-28.309334l-3.029334-1.450666a21.333333 21.333333 0 0 0-26.368 6.442666c-33.6 45.013333-64.469333 78.826667-92.608 101.482667l-5.909333 4.757333-2.837333 0.597334-52.138667-13.973334 11.114667-20.266666c3.242667-5.888 6.72-12.416 10.453333-19.626667 6.997333-13.461333 17.962667-35.946667 32.896-67.434667a20.970667 20.970667 0 0 0-10.112-28.010666l-3.328-1.536a21.333333 21.333333 0 0 0-26.069333 6.613333c-33.642667 45.056-64.554667 78.976-92.778667 101.696l-5.909333 4.757333-2.837334 0.597334-32.64-8.746667 11.093334-20.245333c3.541333-6.506667 7.04-13.034667 10.453333-19.626667 6.976-13.482667 17.941333-35.968 32.874667-67.456a21.056 21.056 0 0 0-10.069334-28.074667l-3.242666-1.514666a21.333333 21.333333 0 0 0-26.154667 6.549333z" />
  </svg>
);

type PickerKind = "lineWidth" | "textSize" | "none";

type ToolMeta = {
  icon: () => JSX.Element;
  label: string;
  hasFill: boolean;
  picker: PickerKind;
  /** Whether this tool cares about the color pool (bucket does; selection doesn't). */
  hasColor: boolean;
};

const TOOL_META: Record<ToolMode, ToolMeta> = {
  rect: { icon: IconRect, label: "矩形", hasFill: true, picker: "lineWidth", hasColor: true },
  ellipse: {
    icon: IconEllipse,
    label: "椭圆",
    hasFill: true,
    picker: "lineWidth",
    hasColor: true,
  },
  line: { icon: IconLine, label: "直线", hasFill: false, picker: "lineWidth", hasColor: true },
  arrow: { icon: IconArrow, label: "箭头", hasFill: false, picker: "lineWidth", hasColor: true },
  pen: { icon: IconPen, label: "画笔", hasFill: false, picker: "lineWidth", hasColor: true },
  text: { icon: IconText, label: "文本", hasFill: false, picker: "textSize", hasColor: true },
  bucket: { icon: IconBucket, label: "油漆桶", hasFill: false, picker: "none", hasColor: true },
  selection: {
    icon: IconSelectBox,
    label: "框选移动",
    hasFill: false,
    picker: "none",
    hasColor: false,
  },
};

function hasAnyPopoverContent(meta: ToolMeta): boolean {
  return meta.picker !== "none" || meta.hasFill || meta.hasColor;
}

// ---------- Shared pickers ----------

function CustomColorPanel({
  draft,
  onDraftChange,
  onConfirm,
  onCancel,
}: {
  draft: string;
  onDraftChange: (c: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [hexInput, setHexInput] = useState<string>(draft);

  // draft 变化时同步 hex 输入框
  useEffect(() => {
    setHexInput(draft);
  }, [draft]);

  const commitHexInput = () => {
    const normalized = normalizeColor(hexInput);
    if (normalized === null) {
      setHexInput(draft); // 非法 → 回滚
      return;
    }
    onDraftChange(normalized);
  };

  // 吸色：浏览器原生 EyeDropper API（Chrome 95+ / Edge 95+；Firefox / Safari 不支持）。
  // 不支持的浏览器隐藏按钮。
  const eyedropperSupported = typeof window !== "undefined" && "EyeDropper" in window;
  const pickFromScreen = async () => {
    type EyeDropperApi = { open: () => Promise<{ sRGBHex: string }> };
    const w = window as Window & { EyeDropper?: new () => EyeDropperApi };
    if (!w.EyeDropper) {
      return;
    }
    try {
      const ed = new w.EyeDropper();
      const result = await ed.open();
      onDraftChange(result.sRGBHex); // "#rrggbb"
    } catch {
      // 用户按 Esc 取消 → ignore
    }
  };

  // hex → hsva for the @uiw/react-color components（只取前 7 位，忽略历史 8 位输入）
  const hsva = hexToHsva(draft.length >= 7 ? draft.slice(0, 7) : "#000000");

  return (
    <div
      data-color-panel="true"
      className={tx(
        "absolute bottom-full right-0 mb-2 p-3 bg-white rounded-lg shadow-lg border border-gray-200 z-50",
      )}
      style={{ width: 280 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* 顶部行：SV 方块（左）+ 垂直 Hue 条（右） */}
      <div className={tx("flex gap-1.5")}>
        <Saturation
          hsva={hsva}
          onChange={(newColor) => {
            onDraftChange(hsvaToHex(newColor));
          }}
          style={{ width: 240, height: 140, borderRadius: 4 }}
        />
        <Hue
          hue={hsva.h}
          direction="vertical"
          onChange={(newHue) => {
            onDraftChange(hsvaToHex({ ...hsva, h: newHue.h }));
          }}
          style={{ width: 14, height: 140, borderRadius: 4 }}
        />
      </div>

      {/* 底栏：吸管 + hex 输入（左） / 清空 + 确定（右） */}
      <div className={tx("flex items-center gap-2 mt-3")}>
        {eyedropperSupported && (
          <button
            type="button"
            onClick={pickFromScreen}
            title="吸取屏幕颜色"
            className={tx(
              "w-7 h-7 rounded border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50 transition flex-shrink-0",
            )}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M19.07 4.93a3 3 0 0 0-4.24 0l-1.7 1.7-.71-.71a1 1 0 0 0-1.41 1.41l.7.71-7.42 7.42a2 2 0 0 0-.59 1.41V19a1 1 0 0 0 1 1h2.12a2 2 0 0 0 1.42-.59l7.42-7.42.7.7a1 1 0 0 0 1.41-1.41l-.7-.7 1.7-1.71a3 3 0 0 0 0-4.24zM7.83 17.59a.99.99 0 0 1-.71.29H6v-1.12a1 1 0 0 1 .29-.71l7.42-7.42 1.42 1.42-7.3 7.54z" />
            </svg>
          </button>
        )}
        <input
          type="text"
          value={hexInput}
          onChange={(e) => setHexInput(e.target.value)}
          onBlur={commitHexInput}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitHexInput();
            }
          }}
          className={tx(
            "flex-1 min-w-0 px-2 py-1 border border-gray-300 rounded text-sm font-mono outline-none focus:border-indigo-400",
          )}
          spellCheck={false}
        />
        <button
          onClick={onCancel}
          className={tx(
            "px-3 py-1 text-sm rounded border border-gray-300 hover:bg-gray-50 transition flex-shrink-0",
          )}
        >
          清空
        </button>
        <button
          onClick={onConfirm}
          className={tx(
            "px-3 py-1 text-sm rounded bg-indigo-500 text-white hover:bg-indigo-600 transition flex-shrink-0",
          )}
        >
          确定
        </button>
      </div>
    </div>
  );
}

function ColorPalette({
  value,
  onChange,
  customColor,
  onCustomColorChange,
}: {
  value: string;
  onChange: (c: string) => void;
  // 自定义已确认色（提升到 Toolbar 层级）：仅当用户在自定义面板点「确定」时才更新；选预设不影响。
  // null = 用户尚未确认过任何自定义色；色块用棋盘格白底显示。
  customColor: string | null;
  onCustomColorChange: (c: string | null) => void;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [draft, setDraft] = useState<string>(value);

  // 面板打开时种 draft：优先复用上次自定义色，否则用当前画布色
  useEffect(() => {
    if (panelOpen) {
      setDraft(customColor ?? value);
    }
  }, [panelOpen, customColor, value]);

  // 外点关闭：捕获阶段，避免被画布 mousedown 抢跑
  useEffect(() => {
    if (!panelOpen) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest("[data-color-panel]")) {
        return;
      }
      if (t?.closest("[data-color-trigger]")) {
        return;
      }
      setPanelOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [panelOpen]);

  const handleSelect = (c: string) => {
    onChange(c);
  };

  const handleConfirm = () => {
    onCustomColorChange(draft);
    onChange(draft);
    setPanelOpen(false);
  };

  // 色块显示色：面板开 → draft 实时预览；面板关 → 上次确认的自定义色（无则保持空棋盘）
  const swatchColor = panelOpen ? draft : customColor;
  // 高亮：面板关闭、有自定义色、且当前画布色 === 自定义色（即用户用的是自定义而非预设）
  const customActive =
    !panelOpen && customColor !== null && value.toLowerCase() === customColor.toLowerCase();
  const isActive = (c: string) => c.toLowerCase() === value.toLowerCase();

  return (
    <div className={tx("flex gap-1.5 items-center relative")}>
      {COLORS.map((c) => (
        <button
          key={c}
          onClick={() => handleSelect(c)}
          className={tx(
            "w-5 h-5 rounded transition border",
            isActive(c) ? "ring-2 ring-indigo-400 scale-110" : "border-gray-300",
          )}
          style={{ backgroundColor: c }}
        />
      ))}
      <div className={tx("w-px h-5 bg-gray-200 mx-1")} />
      <button
        data-color-trigger="true"
        onClick={() => setPanelOpen((v) => !v)}
        className={tx(
          "w-5 h-5 rounded transition relative overflow-hidden hover:scale-110",
          customActive ? "ring-2 ring-indigo-400 scale-110" : "border border-gray-300",
        )}
        style={{
          backgroundImage: "repeating-conic-gradient(#e5e7eb 0% 25%, #ffffff 0% 50%)",
          backgroundSize: "6px 6px",
        }}
        title="自定义颜色"
      >
        {swatchColor !== null && (
          <span className={tx("absolute inset-0")} style={{ background: swatchColor }} />
        )}
      </button>
      {panelOpen && (
        <CustomColorPanel
          draft={draft}
          onDraftChange={setDraft}
          onConfirm={handleConfirm}
          onCancel={() => setPanelOpen(false)}
        />
      )}
    </div>
  );
}

function LineWidthPicker({ value, onChange }: { value: number; onChange: (w: number) => void }) {
  return (
    <div className={tx("flex gap-1.5 items-center")}>
      {LINE_WIDTHS.map((w) => (
        <button
          key={w}
          onClick={() => onChange(w)}
          className={tx(
            "w-7 h-7 rounded flex items-center justify-center transition",
            w === value ? "bg-indigo-100" : "hover:bg-gray-100",
          )}
          title={`${w}px`}
        >
          <div className={tx("rounded-full bg-gray-700")} style={{ width: w + 2, height: w + 2 }} />
        </button>
      ))}
    </div>
  );
}

function FillToggle({
  shape,
  value,
  onChange,
}: {
  shape: "rect" | "ellipse";
  value: FillMode;
  onChange: (m: FillMode) => void;
}) {
  const radius = shape === "ellipse" ? "50%" : "2px";
  return (
    <div className={tx("flex gap-1 items-center")}>
      <button
        onClick={() => onChange("stroke")}
        className={tx(
          "w-7 h-7 rounded flex items-center justify-center transition",
          value === "stroke" ? "bg-indigo-100" : "hover:bg-gray-100",
        )}
        title="线框"
      >
        <span
          style={{
            display: "block",
            width: 14,
            height: 14,
            border: "2px solid currentColor",
            borderRadius: radius,
          }}
        />
      </button>
      <button
        onClick={() => onChange("fill")}
        className={tx(
          "w-7 h-7 rounded flex items-center justify-center transition",
          value === "fill" ? "bg-indigo-100" : "hover:bg-gray-100",
        )}
        title="填充"
      >
        <span
          style={{
            display: "block",
            width: 14,
            height: 14,
            background: "currentColor",
            borderRadius: radius,
          }}
        />
      </button>
    </div>
  );
}

function TextSizePicker({ value, onChange }: { value: TextSize; onChange: (s: TextSize) => void }) {
  return (
    <div className={tx("flex gap-1 items-center")}>
      {(["small", "medium", "large"] as TextSize[]).map((s) => (
        <button
          key={s}
          onClick={() => onChange(s)}
          className={tx(
            "h-7 px-2 rounded flex items-center justify-center transition text-sm",
            value === s
              ? "bg-indigo-100 text-indigo-700 font-semibold"
              : "hover:bg-gray-100 text-gray-700",
          )}
        >
          {TEXT_SIZE_LABEL[s]}
        </button>
      ))}
    </div>
  );
}

// ---------- Popover (clamped to viewport) ----------

/**
 * Popover that floats above a tool button. By default its horizontal center
 * aligns with the anchor button, but if that would push it past the viewport
 * edge, we shift the whole popover inward while keeping the triangle pointed
 * at the button. Runs on mount and on window resize.
 */
function ToolPopover({
  anchorEl,
  children,
}: {
  anchorEl: HTMLElement | null;
  children: React.ReactNode;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [leftOffset, setLeftOffset] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      const popover = popoverRef.current;
      if (!popover || !anchorEl) {
        return;
      }
      const popRect = popover.getBoundingClientRect();
      const btnRect = anchorEl.getBoundingClientRect();
      const viewport = window.innerWidth;
      const margin = 8;

      // Where the popover *would* land if perfectly centered on the button.
      const desiredLeft = btnRect.left + btnRect.width / 2 - popRect.width / 2;
      let clampedLeft = desiredLeft;
      if (clampedLeft < margin) {
        clampedLeft = margin;
      }
      if (clampedLeft + popRect.width > viewport - margin) {
        clampedLeft = viewport - margin - popRect.width;
      }
      setLeftOffset(clampedLeft - desiredLeft);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchorEl]);

  return (
    <div
      ref={popoverRef}
      className={tx(
        "absolute bottom-full mb-2",
        "bg-white rounded-xl shadow-lg border border-gray-100",
        "px-3 py-2 flex items-center gap-2 whitespace-nowrap",
      )}
      style={{
        left: "50%",
        transform: `translateX(calc(-50% + ${leftOffset}px))`,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
      {/* Triangle tip: counter-offsets the popover shift so it still points at the button */}
      <div
        className={tx("absolute")}
        style={{
          left: "50%",
          transform: `translateX(calc(-50% - ${leftOffset}px))`,
          bottom: -6,
          width: 0,
          height: 0,
          borderLeft: "6px solid transparent",
          borderRight: "6px solid transparent",
          borderTop: "6px solid white",
          filter: "drop-shadow(0 1px 0 rgba(0,0,0,0.05))",
        }}
      />
    </div>
  );
}

// ---------- Toolbar ----------

interface Props {
  color: string;
  lineWidth: number;
  tool: ToolMode;
  fillMode: FillMode;
  textSize: TextSize;
  onColorChange: (c: string) => void;
  onLineWidthChange: (w: number) => void;
  onToolChange: (t: ToolMode) => void;
  onFillModeChange: (m: FillMode) => void;
  onTextSizeChange: (s: TextSize) => void;
  onClear: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  disabled: boolean;
}

export default function Toolbar({
  color,
  lineWidth,
  tool,
  fillMode,
  textSize,
  onColorChange,
  onLineWidthChange,
  onToolChange,
  onFillModeChange,
  onTextSizeChange,
  onClear,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  disabled,
}: Props) {
  // Which tool's popover is currently open. null = closed.
  const [openPopover, setOpenPopover] = useState<ToolMode | null>(null);
  // 自定义色：在 Toolbar 层级保存，popover 关闭重开后仍记得。
  // null = 用户尚未在自定义面板点过「确定」。
  const [customColor, setCustomColor] = useState<string | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // One ref per tool button — popover reads the active one to compute its anchor.
  const buttonRefs = useRef<Record<ToolMode, HTMLButtonElement | null>>({
    rect: null,
    ellipse: null,
    line: null,
    arrow: null,
    pen: null,
    text: null,
    bucket: null,
    selection: null,
  });

  // Close popover on outside click
  useEffect(() => {
    if (openPopover === null) {
      return;
    }
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) {
        return;
      }
      if (toolbarRef.current?.contains(target)) {
        return;
      }
      setOpenPopover(null);
    };
    window.addEventListener("mousedown", handleMouseDown);
    return () => window.removeEventListener("mousedown", handleMouseDown);
  }, [openPopover]);

  const handleToolClick = (t: ToolMode) => {
    const meta = TOOL_META[t];
    const canPopover = hasAnyPopoverContent(meta);
    if (tool !== t) {
      onToolChange(t);
      setOpenPopover(canPopover ? t : null);
      return;
    }
    // Same tool clicked again — toggle its popover (only if it has one).
    if (canPopover) {
      setOpenPopover((cur) => (cur === t ? null : t));
    }
  };

  // Render a single tool button (+ its popover when open). Shared helper so
  // the tool group split below doesn't duplicate ~40 lines of JSX.
  const renderToolButton = (t: ToolMode) => {
    const meta = TOOL_META[t];
    const Icon = meta.icon;
    const active = tool === t;
    const popoverOpen = openPopover === t;
    return (
      <div key={t} className={tx("relative")}>
        <button
          ref={(el) => {
            buttonRefs.current[t] = el;
          }}
          onClick={() => handleToolClick(t)}
          title={meta.label}
          className={tx(
            "w-9 h-9 rounded-lg flex items-center justify-center transition",
            active
              ? "bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300"
              : "text-gray-600 hover:bg-gray-100",
          )}
        >
          <Icon />
        </button>

        {popoverOpen && (
          <ToolPopover anchorEl={buttonRefs.current[t]}>
            {meta.picker === "textSize" && (
              <TextSizePicker value={textSize} onChange={onTextSizeChange} />
            )}
            {meta.picker === "lineWidth" && (
              <LineWidthPicker value={lineWidth} onChange={onLineWidthChange} />
            )}
            {meta.hasFill && (
              <>
                <div className={tx("w-px h-6 bg-gray-200")} />
                <FillToggle
                  shape={t as "rect" | "ellipse"}
                  value={fillMode}
                  onChange={onFillModeChange}
                />
              </>
            )}
            {meta.hasColor && (meta.picker !== "none" || meta.hasFill) && (
              <div className={tx("w-px h-6 bg-gray-200")} />
            )}
            {meta.hasColor && (
              <ColorPalette
                value={color}
                onChange={onColorChange}
                customColor={customColor}
                onCustomColorChange={setCustomColor}
              />
            )}
          </ToolPopover>
        )}
      </div>
    );
  };

  return (
    <div
      ref={toolbarRef}
      className={tx(
        "flex items-center gap-2 p-2 bg-white rounded-xl shadow-sm relative",
        disabled && "opacity-50 pointer-events-none",
      )}
    >
      {/* Primary tools: pen, text */}
      <div className={tx("flex gap-1 items-center")}>
        {PRIMARY_TOOLS.map((t) => renderToolButton(t))}
      </div>

      <div className={tx("w-px h-7 bg-gray-200")} />

      {/* Shape tools: rect, ellipse, arrow */}
      <div className={tx("flex gap-1 items-center")}>
        {SHAPE_TOOLS.map((t) => renderToolButton(t))}
      </div>

      <div className={tx("w-px h-7 bg-gray-200")} />

      {/* Actions */}
      <div className={tx("flex gap-1 items-center")}>
        <button
          onClick={onUndo}
          disabled={!canUndo}
          title="撤销"
          className={tx(
            "w-9 h-9 rounded-lg flex items-center justify-center transition",
            canUndo ? "text-gray-600 hover:bg-gray-100" : "text-gray-300 cursor-not-allowed",
          )}
        >
          <IconUndo />
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          title="重做"
          className={tx(
            "w-9 h-9 rounded-lg flex items-center justify-center transition",
            canRedo ? "text-gray-600 hover:bg-gray-100" : "text-gray-300 cursor-not-allowed",
          )}
        >
          <IconRedo />
        </button>
      </div>

      <div className={tx("w-px h-7 bg-gray-200")} />

      {/* Clear — standalone group, separated by its own divider */}
      <div className={tx("flex items-center")}>
        <button
          onClick={onClear}
          title="清除"
          className={tx(
            "w-9 h-9 rounded-lg flex items-center justify-center transition",
            "text-red-500 hover:bg-red-50",
          )}
        >
          <IconClear />
        </button>
      </div>
    </div>
  );
}

// Re-export the px mapping for consumers (Room uses it to convert TextSize → fontSize)
export { TEXT_SIZE_TO_PX };
