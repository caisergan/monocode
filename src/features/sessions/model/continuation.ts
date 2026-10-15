import {
  isEditTool,
  isReadTool,
} from "../../../integrations/harness/core/preview";
import { compactCiRepairContext } from "../../inbox/model/ciRepair";
import { limitSection } from "../../../shared/lib/jsonText";
import { displayPath } from "../../../shared/lib/paths";
import type { Block, Session } from "./session";

const FIRST_REQUEST_LIMIT = 1_200;
const RECENT_USER_LIMIT = 600;
const MAX_RECENT_USERS = 3;
const LATEST_LIMIT = 8_000;
const PLAN_LIMIT = 1_500;
const EARLIER_LIMIT = 4_000;
const CI_LIMIT = 900;
const MAX_CHANGED = 60;
const MAX_READ = 30;

type FileChange = {
  label: string;
  additions: number;
  deletions: number;
  counted: boolean;
};

export type ContinuationBrief = {
  brief: string;
  changedFiles: string[];
};

/**
 * Recap for continuing a session in a fresh chat, built from the transcript
 * alone. Asking the old thread to summarize would replay its whole context,
 * which is the cost a fresh chat exists to avoid once the prompt cache is cold.
 */
export function buildContinuationBrief(
  session: Session,
  cwd = session.cwd,
): ContinuationBrief {
  const users: Block[] = [];
  let latestUserIndex = -1;
  let lastPlan = "";
  let lastTasks = "";
  const changes = new Map<string, FileChange>();
  const reads = new Map<string, string>();

  session.blocks.forEach((block, index) => {
    if (block.internal) return;
    if (block.role === "user") {
      users.push(block);
      latestUserIndex = index;
      return;
    }
    if (block.role === "plan" && block.text.trim()) lastPlan = block.text;
    if (block.role === "tasks" && block.text.trim()) lastTasks = block.text;
    if (block.role !== "tool" && block.role !== "approval") return;
    const title = block.text || block.tool?.title;
    const preview = block.tool?.preview;
    if (isEditTool(block.tool?.kind, title, preview)) {
      const label = fileLabel(block, cwd);
      if (!label) return;
      const key = label.toLowerCase();
      let entry = changes.get(key);
      if (!entry) {
        entry = { label, additions: 0, deletions: 0, counted: false };
        changes.set(key, entry);
      }
      if (preview?.additions != null || preview?.deletions != null) {
        entry.additions += preview.additions ?? 0;
        entry.deletions += preview.deletions ?? 0;
        entry.counted = true;
      }
      return;
    }
    if (isReadTool(block.tool?.kind, title, preview)) {
      const path = preview?.path ? displayPath(preview.path, cwd) : undefined;
      if (!path) return;
      const key = path.toLowerCase();
      reads.delete(key);
      reads.set(key, path);
    }
  });

  const sections: string[] = [];
  const earlier = users[0]?.secondOpinion?.brief?.trim();
  if (earlier) {
    sections.push(
      `## Earlier context\nThis chat already continued an earlier one. Its recap:\n\n${limitSection(earlier, EARLIER_LIMIT)}`,
    );
  }

  const texts = users.map((block) => block.text.trim());
  if (texts[0]) {
    sections.push(
      `## First request\n${limitSection(texts[0], FIRST_REQUEST_LIMIT)}`,
    );
  }
  const later = texts.slice(1).filter(Boolean);
  const recent = later.slice(-MAX_RECENT_USERS);
  if (recent.length > 0) {
    const omitted = later.length - recent.length;
    sections.push(
      [
        "## Latest requests",
        omitted > 0 ? `(${omitted} earlier messages omitted)` : "",
        ...recent.map(
          (text) => `- ${oneLine(limitSection(text, RECENT_USER_LIMIT))}`,
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const latest = session.blocks
    .slice(latestUserIndex + 1)
    .filter((block) => block.role === "assistant" && !block.internal)
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
  if (latest) {
    sections.push(`## Latest response\n${keepEnd(latest, LATEST_LIMIT)}`);
  }
  if (lastPlan) {
    sections.push(`## Plan\n${limitSection(lastPlan.trim(), PLAN_LIMIT)}`);
  }
  if (lastTasks) {
    sections.push(
      `## Current tasks\n${limitSection(lastTasks.trim(), PLAN_LIMIT)}`,
    );
  }

  const changed = [...changes.values()];
  if (changed.length > 0) {
    sections.push(
      `## Files changed in this session\n${listWithOverflow(
        changed.map(changeLine),
        MAX_CHANGED,
      )}\nOnly edits made with file tools are listed; run \`git diff\` on a file before relying on its contents.`,
    );
  }
  const readOnly = [...reads.entries()]
    .filter(([key]) => !changes.has(key))
    .map(([, path]) => path)
    .reverse();
  if (readOnly.length > 0) {
    sections.push(
      `## Files read in this session\n${listWithOverflow(readOnly, MAX_READ, "most recent first")}`,
    );
  }

  const ciContext = users[users.length - 1]?.ciContext;
  if (ciContext) {
    sections.push(
      `## CI context\n${compactCiRepairContext(ciContext, CI_LIMIT)}`,
    );
  }

  return {
    brief: sections.join("\n\n"),
    changedFiles: changed.map((entry) => entry.label),
  };
}

function fileLabel(block: Block, cwd: string): string | undefined {
  const preview = block.tool?.preview;
  const path = preview?.path
    ? displayPath(preview.path, cwd)
    : preview?.fileName;
  return (path || block.text || block.tool?.title || "").trim() || undefined;
}

function changeLine(entry: FileChange): string {
  if (!entry.counted) return entry.label;
  return `${entry.label} (+${entry.additions} −${entry.deletions})`;
}

function listWithOverflow(items: string[], max: number, note?: string) {
  const shown = items.slice(0, max).map((item) => `- ${item}`);
  const rest = items.length - shown.length;
  if (note && items.length > 1) shown.unshift(`(${note})`);
  if (rest > 0) shown.push(`- … and ${rest} more`);
  return shown.join("\n");
}

/** The end of a long reply holds its conclusion, so cut from the start. */
function keepEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[earlier part truncated]\n\n${text.slice(-maxChars)}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
