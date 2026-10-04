// The row contract between JavaScript and MonoTranscriptView (docs/mobile/15
// §15.4). Rows carry style ids, never colours; colours come with setTheme.

export type StyleId =
  | "prose"
  | "strong"
  | "em"
  | "code"
  | "inlineCode"
  | "link"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "marker"
  | "user"
  | "reasoning"
  | "fold"
  | "trailVerb"
  | "trailTarget"
  | "trailFailed"
  | "notice"
  | "meta"
  | "codeLabel"
  | "approvalTitle"
  | "buttonLabel"
  | "primaryLabel"
  | "dangerLabel";

export type TextRun = {
  t: string;
  s: StyleId;
  link?: string;
  /** 1 = inline code chip, 2 = file chip. */
  chip?: 1 | 2;
};

export type RowKind =
  | "markdown"
  | "userBubble"
  | "codeBlock"
  | "trailRow"
  | "thinkingRow"
  | "foldLine"
  | "approvalControls"
  | "notice"
  | "turnFooter"
  | "loadOlder"
  | "spacer";

export type ActionSpec = { id: string; label: string; variant: "primary" | "secondary" | "danger" };

export type RowSpec = {
  id: string;
  /** Bumps on any change; native code re-measures only changed rows. */
  v: number;
  k: RowKind;
  runs?: TextRun[];
  sub?: TextRun[];
  /** Code or preview lines, one run list per line. */
  lines?: TextRun[][];
  label?: string;
  /** Code blocks are cut into chunks; only the first has the header. */
  first?: boolean;
  last?: boolean;
  marker?: string;
  depth?: number;
  quote?: boolean;
  status?: string;
  open?: boolean;
  actions?: ActionSpec[];
  anim?: { pulse?: boolean };
  /** Space above the row, in points. */
  gap?: number;
  /** Spacer height. */
  h?: number;
  a11y?: string;
};

export type TextStyleSpec = {
  size: number;
  line: number;
  weight?: "400" | "500" | "600" | "700";
  mono?: boolean;
  italic?: boolean;
  color: string;
};

export type TranscriptTheme = {
  background: string;
  scale: number;
  colors: Record<string, string>;
  styles: Record<StyleId, TextStyleSpec>;
};

export type TranscriptOp =
  | { op: "reset"; rows: RowSpec[] }
  | { op: "append"; rows: RowSpec[] }
  | { op: "insert"; after: string | null; rows: RowSpec[] }
  | { op: "update"; rows: RowSpec[] }
  | { op: "remove"; ids: string[] };

export type BenchmarkResult = {
  frames: number;
  seconds: number;
  expectedFrameMs: number;
  hitches: number;
  hitchMs: number;
  hitchRatio: number;
  frameP50: number;
  frameP95: number;
  frameP99: number;
  frameMax: number;
  rows: number;
  contentHeight: number;
  rasterCount: number;
  rasterP50: number;
  rasterP95: number;
  syncDraws: number;
  coldFirstMs: number;
  coldTotalMs: number;
  coldRows: number;
  measureP50: number;
  measureP95: number;
  tailUpdates: number;
  tailUpdateP50: number;
  tailUpdateP95: number;
};
