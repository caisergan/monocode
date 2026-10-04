// Phone-facing summary fields computed on the host (spec 06 §6.5, §6.10).

import type { Block, HostSession } from "./session";
import type { Attention, InboxItem } from "./wire";

/** Markdown to one line of plain text, for list rows and notifications. */
export function plainTextPreview(markdown: string, max = 280): string {
  const text = markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, " $1 ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function lastAssistantText(blocks: readonly Block[]): string | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.role === "assistant" && block.text.trim()) return plainTextPreview(block.text);
    if (block.role === "user" && !block.draft) return undefined;
  }
  return undefined;
}

/** The last turn's blocks: from the last submitted user block to the end. */
function lastTurn(blocks: readonly Block[]): readonly Block[] {
  for (let i = blocks.length - 1; i >= 0; i--)
    if (blocks[i].role === "user" && !blocks[i].draft) return blocks.slice(i);
  return blocks;
}

export function sessionAttention(value: HostSession): Attention {
  const { session } = value;
  if (session.blocks.some((block) => block.approval && !block.approval.decided)) return "approval";
  if (session.pendingQuestion) return "question";
  if (value.status === "running") return null;
  const turn = lastTurn(session.blocks);
  if (!turn.some((block) => block.role === "user" && !block.draft)) return null;
  if (turn.some((block) => block.notice === "error")) return "error";
  if (value.status === "interrupted") return "interrupted";
  if (session.usageLimit) return "usage_limit";
  return "finished";
}

const ATTENTION_ORDER: Record<string, number> = {
  approval: 0,
  question: 1,
  error: 2,
  interrupted: 3,
  usage_limit: 4,
  finished: 5,
  null: 6,
};

export function compareInboxItems(a: InboxItem, b: InboxItem): number {
  const order = ATTENTION_ORDER[String(a.attention)] - ATTENTION_ORDER[String(b.attention)];
  if (order) return order;
  return b.updatedAt - a.updatedAt;
}

export function pendingApproval(value: HostSession): InboxItem["approval"] {
  const block = value.session.blocks.find((item) => item.approval && !item.approval.decided);
  if (!block?.approval) return undefined;
  return {
    requestId: block.approval.requestId,
    title: block.tool?.title || block.text || "Approval needed",
    ...(block.tool?.kind ? { kind: block.tool.kind } : {}),
    ...(block.tool?.preview ? { preview: block.tool.preview } : {}),
  };
}

export function pendingQuestionSummary(value: HostSession): InboxItem["question"] {
  const prompt = value.session.pendingQuestion;
  if (!prompt) return undefined;
  return {
    requestId: prompt.requestId,
    ...(prompt.title ? { title: prompt.title } : {}),
    count: prompt.questions.length,
    ...(prompt.autoResolveAt ? { autoResolveAt: prompt.autoResolveAt } : {}),
  };
}
