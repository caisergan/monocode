/** One styled run of a code line. A line's runs join back to the line exactly. */
export type HighlightToken = { text: string; color?: string; fontStyle?: "italic" | "bold" };
export type HighlightedLine = HighlightToken[];
export type ColorScheme = "dark" | "light";
