// The tabs stacked above the composer (11 §11.17, §11.18): the question form,
// the usage limit tab and the queue card. Each sits on the composer as a tab:
// `r.block` top corners and no bottom border.

import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from "react-native";
import type { UserQuestionPrompt, UserQuestionReply } from "@monocode/core/session";
import { RADII } from "@monocode/design";
import { Icon } from "@/ui/icon";
import { Sheet } from "@/ui/sheet";
import { useTokens } from "@/ui/theme";
import { autoResolveText, buildReply, isOther, questionComplete, questionOptions, toggleOption, type Answers } from "./question";
import type { QueueCardState } from "./queue";

function Tab({ children, tone }: { children: ReactNode; tone?: "amber" }) {
  const t = useTokens();
  return (
    <View
      style={{
        marginHorizontal: 6,
        borderTopLeftRadius: RADII.block,
        borderTopRightRadius: RADII.block,
        borderWidth: 1,
        borderBottomWidth: 0,
        borderColor: tone === "amber" ? "rgba(251,191,36,0.25)" : t.border.default,
        backgroundColor: tone === "amber" ? "rgba(251,191,36,0.10)" : t.fill.composer,
        overflow: "hidden",
      }}
    >
      {children}
    </View>
  );
}

function SmallButton({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  const t = useTokens();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8 }}
      style={{
        height: 28,
        paddingHorizontal: 10,
        borderRadius: RADII.sm,
        justifyContent: "center",
        backgroundColor: primary ? t.primary : t.fill.bubble,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text style={{ color: primary ? t.primaryText : t.contentAlpha(0.8), fontSize: 13, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

// ── Usage limit ───────────────────────────────────────────────────────────────

function resetText(resetsAt: number | undefined, now: number): string | undefined {
  if (resetsAt === undefined) return undefined;
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  if (minutes <= 0) return "Limit has reset";
  const hours = Math.floor(minutes / 60);
  return `Resets in ${hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`}`;
}

export function UsageTab({ resetsAt, onResume, onDismiss }: { resetsAt?: number; onResume?: () => void; onDismiss: () => void }) {
  const t = useTokens();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const reset = resetText(resetsAt, now);
  return (
    <Tab tone="amber">
      <View style={{ minHeight: 36, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10 }}>
        <Icon name="gauge.with.dots.needle.67percent" size={14} color={t.status.attention} />
        <Text style={{ color: t.contentAlpha(0.85), fontSize: 13 }}>Usage limit reached</Text>
        {reset ? <Text style={{ flex: 1, color: t.text.secondary, fontSize: 12 }}>{reset}</Text> : <View style={{ flex: 1 }} />}
        {onResume ? <SmallButton label="Resume" onPress={onResume} /> : null}
        <Pressable accessibilityLabel="Dismiss" hitSlop={10} onPress={onDismiss}>
          <Icon name="xmark" size={12} color={t.text.secondary} />
        </Pressable>
      </View>
    </Tab>
  );
}

// ── Queue card ────────────────────────────────────────────────────────────────

export function QueueCard({
  state,
  onSteer,
  onEdit,
  onRemove,
  onResume,
  onRetry,
  onDiscard,
}: {
  state: QueueCardState;
  onSteer: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onResume: () => void;
  onRetry: (commandId: string) => void;
  onDiscard: (commandId: string) => void;
}) {
  const t = useTokens();
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  return (
    <Tab>
      <Text style={{ color: t.text.secondary, fontSize: 12, fontWeight: "500", paddingHorizontal: 10, paddingTop: 8 }}>
        Queued ({state.rows.length})
      </Text>
      <ScrollView style={{ maxHeight: 200 }} keyboardShouldPersistTaps="handled">
        {state.rows.map((row) => (
          <View key={row.id} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
            <Icon name="arrow.turn.down.right" size={13} color={t.text.secondary} />
            {editing?.id === row.id ? (
              <>
                <TextInput
                  autoFocus
                  value={editing.text}
                  onChangeText={(text) => setEditing({ id: row.id, text })}
                  multiline
                  style={{ flex: 1, color: t.content, fontSize: 14, maxHeight: 96, paddingVertical: 4 }}
                />
                <SmallButton
                  label="Save"
                  primary
                  disabled={!editing.text.trim() && !row.attachments}
                  onPress={() => {
                    onEdit(row.id, editing.text);
                    setEditing(undefined);
                  }}
                />
                <SmallButton label="Cancel" onPress={() => setEditing(undefined)} />
              </>
            ) : (
              <>
                <Text numberOfLines={1} style={{ flex: 1, color: t.contentAlpha(row.pending ? 0.5 : 0.8), fontSize: 14 }}>
                  {row.text.trim() || `${row.attachments} attachment${row.attachments === 1 ? "" : "s"}`}
                </Text>
                {row.failedEntry ? (
                  <>
                    <SmallButton label="Retry" onPress={() => onRetry(row.failedEntry!)} />
                    <SmallButton label="Discard" onPress={() => onDiscard(row.failedEntry!)} />
                  </>
                ) : row.canEdit ? (
                  <>
                    {row.canSteer ? <SmallButton label="Steer" onPress={() => onSteer(row.id)} /> : null}
                    <SmallButton label="Edit" onPress={() => setEditing({ id: row.id, text: row.text })} />
                    <SmallButton label="Remove" onPress={() => onRemove(row.id)} />
                  </>
                ) : (
                  <Text style={{ color: t.text.faint, fontSize: 12 }}>Sending…</Text>
                )}
              </>
            )}
          </View>
        ))}
      </ScrollView>
      {state.paused ? (
        <View style={{ minHeight: 40, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, borderTopWidth: 1, borderColor: t.stroke }}>
          <Icon name="pause.fill" size={12} color={t.text.secondary} />
          <Text style={{ flex: 1, color: t.text.secondary, fontSize: 13 }}>{state.pausedText}</Text>
          <SmallButton label="Resume" primary onPress={onResume} />
        </View>
      ) : null}
    </Tab>
  );
}

// ── Question form ─────────────────────────────────────────────────────────────

/** The desktop's QuestionForm, above the composer. A form that would cover
 * more than 60 % of the screen opens as a sheet instead. */
export function QuestionForm({
  prompt,
  sending,
  onSubmit,
}: {
  prompt: UserQuestionPrompt;
  sending: boolean;
  onSubmit: (reply: UserQuestionReply) => void;
}) {
  const t = useTokens();
  const { height: screen } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Answers>({ selected: {}, custom: {} });
  const [tall, setTall] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (prompt.autoResolveAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [prompt.autoResolveAt]);

  const questions = prompt.questions;
  const question = questions[Math.min(index, questions.length - 1)];
  if (!question) return null;
  const last = index >= questions.length - 1;
  const advance = (next: Answers) => {
    if (last) {
      setSheet(false);
      onSubmit(buildReply(questions, next));
    } else setIndex(index + 1);
  };
  const skip = () => {
    const next: Answers = {
      selected: { ...answers.selected, [question.id]: [] },
      custom: { ...answers.custom, [question.id]: "" },
    };
    setAnswers(next);
    advance(next);
  };
  const selected = answers.selected[question.id] ?? [];
  const otherChosen = selected.some((id) => {
    const option = questionOptions(question).find((item) => item.id === id);
    return option ? isOther(option) : false;
  });
  const footer = autoResolveText(prompt.autoResolveAt, now) ?? (question.options.length ? undefined : "Optional question");

  const content = (
    <View style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="message" size={14} color={t.contentAlpha(0.45)} />
        <Text numberOfLines={1} style={{ flex: 1, color: t.text.secondary, fontSize: 13, fontWeight: "500" }}>
          {question.header || prompt.title || "Question"}
          {questions.length > 1 ? `  ${index + 1} of ${questions.length}` : ""}
        </Text>
        <Pressable accessibilityRole="button" onPress={skip} hitSlop={10} disabled={sending}>
          <Text style={{ color: t.text.secondary, fontSize: 13, fontWeight: "500" }}>Skip</Text>
        </Pressable>
      </View>
      <Text style={{ color: t.content, fontSize: 15, fontWeight: "500", lineHeight: 21 }}>{question.prompt}</Text>
      {question.multiSelect ? <Text style={{ color: t.text.faint, fontSize: 12 }}>Select all that apply</Text> : null}
      {questionOptions(question).map((option) => {
        const on = selected.includes(option.id);
        return (
          <Pressable
            key={option.id}
            accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
            accessibilityState={{ checked: on }}
            onPress={() => setAnswers(toggleOption(answers, question, option.id))}
            style={{
              minHeight: 48,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: RADII.md,
              borderWidth: 1,
              borderColor: on ? t.contentAlpha(0.35) : t.border.default,
              backgroundColor: on ? t.selection.normal : "transparent",
            }}
          >
            <View
              style={{
                width: 16,
                height: 16,
                borderRadius: question.multiSelect ? RADII.xs : 8,
                borderWidth: 1,
                borderColor: on ? t.content : t.contentAlpha(0.35),
                backgroundColor: on ? t.content : "transparent",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {on ? <Icon name="checkmark" size={10} color={t.base} /> : null}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.content, fontSize: 14 }}>{option.label}</Text>
              {option.description ? <Text style={{ color: t.text.secondary, fontSize: 13 }}>{option.description}</Text> : null}
            </View>
          </Pressable>
        );
      })}
      {otherChosen || (question.allowCustom && !question.options.length) ? (
        <TextInput
          value={answers.custom[question.id] ?? ""}
          onChangeText={(text) => setAnswers({ ...answers, custom: { ...answers.custom, [question.id]: text } })}
          placeholder="Type your answer"
          placeholderTextColor={t.text.faint}
          multiline
          style={{ color: t.content, fontSize: 14, borderWidth: 1, borderColor: t.border.default, borderRadius: RADII.md, padding: 10, minHeight: 44 }}
        />
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, color: t.text.faint, fontSize: 12 }}>{footer ?? ""}</Text>
        {sending ? <ActivityIndicator size="small" color={t.text.secondary} /> : null}
        <SmallButton
          label={sending ? "Sending…" : "Continue"}
          primary
          disabled={sending || (!questionComplete(question, answers) && selected.length > 0)}
          onPress={() => advance(answers)}
        />
      </View>
    </View>
  );

  if (tall)
    return (
      <Tab>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, minHeight: 44 }}>
          <Icon name="message" size={14} color={t.contentAlpha(0.45)} />
          <Text numberOfLines={1} style={{ flex: 1, color: t.content, fontSize: 14 }}>
            {prompt.title || question.header || "Question"}
            {questions.length > 1 ? `  ${index + 1} of ${questions.length}` : ""}
          </Text>
          <SmallButton label="Answer" primary onPress={() => setSheet(true)} />
        </View>
        <Sheet visible={sheet} onClose={() => setSheet(false)} title="Question">
          {content}
        </Sheet>
      </Tab>
    );
  return (
    <Tab>
      <View onLayout={(event) => setTall(event.nativeEvent.layout.height > screen * 0.6)}>{content}</View>
    </Tab>
  );
}
