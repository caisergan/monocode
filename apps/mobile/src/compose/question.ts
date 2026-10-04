// The question form's answers (11 §11.18), with the desktop's rules
// (`userQuestion.ts`): a question is complete with one choice (or several for
// multi-select), and "Other" needs its text. Pure.

import type { UserQuestion, UserQuestionReply } from "@monocode/core/session";

const CUSTOM_OPTION_ID = "__custom__";

export type Answers = { selected: Record<string, string[]>; custom: Record<string, string> };

export const isOther = (option: { id: string; label: string }) =>
  option.id === CUSTOM_OPTION_ID || /^other$/i.test(option.label.trim());

/** Options to show, with an "Other" row when the question allows text. */
export function questionOptions(question: UserQuestion): { id: string; label: string; description?: string }[] {
  const options = question.options;
  if (!question.allowCustom || options.some(isOther)) return options;
  return [...options, { id: CUSTOM_OPTION_ID, label: "Other" }];
}

function otherSelected(question: UserQuestion, id: string): boolean {
  if (id === CUSTOM_OPTION_ID) return true;
  const option = question.options.find((item) => item.id === id);
  return option ? isOther(option) : false;
}

/** Toggles an option: single-select replaces, multi-select adds or removes. */
export function toggleOption(answers: Answers, question: UserQuestion, optionId: string): Answers {
  const current = answers.selected[question.id] ?? [];
  const next = question.multiSelect
    ? current.includes(optionId)
      ? current.filter((id) => id !== optionId)
      : [...current, optionId]
    : [optionId];
  return { ...answers, selected: { ...answers.selected, [question.id]: next } };
}

export function questionComplete(question: UserQuestion, answers: Answers): boolean {
  const selected = answers.selected[question.id] ?? [];
  const custom = answers.custom[question.id]?.trim();
  if (!selected.length) return question.allowCustom && !!custom;
  if (!question.multiSelect && selected.length !== 1) return false;
  return selected.every((id) => !otherSelected(question, id) || !!custom);
}

/** Answered questions only; nothing answered is a skip. */
export function buildReply(questions: readonly UserQuestion[], answers: Answers): UserQuestionReply {
  const answered = questions.filter((question) => questionComplete(question, answers));
  if (!answered.length) return { kind: "skipped" };
  const selected: Record<string, string[]> = {};
  const custom: Record<string, string> = {};
  for (const question of answered) {
    const ids = answers.selected[question.id];
    if (ids?.length) selected[question.id] = ids;
    const text = answers.custom[question.id]?.trim();
    if (text) custom[question.id] = text;
  }
  return { kind: "answered", answers: selected, ...(Object.keys(custom).length ? { custom } : {}) };
}

/** "Continues without an answer in 14s", or undefined without a deadline. */
export function autoResolveText(autoResolveAt: number | undefined, now: number): string | undefined {
  if (autoResolveAt === undefined) return undefined;
  const seconds = Math.max(0, Math.ceil((autoResolveAt - now) / 1000));
  return `Continues without an answer in ${seconds}s`;
}
