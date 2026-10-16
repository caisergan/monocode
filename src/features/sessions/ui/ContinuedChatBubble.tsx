import { ChevronRight, Replace } from "../../../shared/ui/icons";
import { HARNESS_TITLE, type SecondOpinionMeta } from "../model/session";
import { HarnessIcon } from "./HarnessIcon";

type Props = {
  card: SecondOpinionMeta;
  /** Right-aligned in the chat layout, like the message under it. */
  chat: boolean;
  onOpenSession?: (sessionId: string) => void;
};

/** The chat a continued chat was read from, sitting above its first message. */
export function ContinuedChatBubble({ card, chat, onOpenSession }: Props) {
  const files =
    card.files != null && card.files > 0
      ? `${card.files} ${card.files === 1 ? "file" : "files"}`
      : null;
  const title = card.source ?? HARNESS_TITLE[card.from];
  const sourceId = card.sourceId;
  const open = sourceId && onOpenSession ? () => onOpenSession(sourceId) : null;
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-content/45">
        <Replace className="size-3 shrink-0" strokeWidth={1.75} />
        <span className="truncate">
          {card.source ? "Continued from" : "Continued chat"}
        </span>
        {files ? (
          <>
            <span aria-hidden>·</span>
            <span className="shrink-0">{files}</span>
          </>
        ) : null}
      </span>
      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] font-medium leading-snug text-content">
        <HarnessIcon harness={card.from} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{title}</span>
        {open ? (
          <ChevronRight
            className="size-3 shrink-0 text-content/35 transition-transform duration-150 group-hover/continued:translate-x-0.5 group-hover/continued:text-content/60"
            strokeWidth={1.75}
          />
        ) : null}
      </span>
    </>
  );
  const shape = `flex min-w-0 max-w-[min(100%,24rem)] flex-col border border-content/10 bg-content/5 px-3 py-2 text-left font-sans ${
    chat ? "self-end rounded-2xl" : "self-start rounded-lg"
  }`;

  return open ? (
    <button
      type="button"
      title={`Open ${title}`}
      onClick={(event) => {
        event.stopPropagation();
        open();
      }}
      className={`group/continued ${shape} transition-colors duration-150 hover:border-content/15 hover:bg-content/8 focus-visible:outline focus-visible:outline-1 focus-visible:outline-content/40`}
    >
      {body}
    </button>
  ) : (
    <div className={shape}>{body}</div>
  );
}
