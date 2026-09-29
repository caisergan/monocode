import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Search } from "../../../shared/ui/icons";

/** Search box of a sessions list header. Escape clears the query first. */
export function SessionsSearchField({
  inputRef,
  value,
  onChange,
  autoFocus = false,
  releaseEmptyEscape = false,
}: {
  inputRef?: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  /** Let Escape on an empty box reach the surrounding dialog. */
  releaseEmptyEscape?: boolean;
}) {
  return (
    <div className="relative flex h-7 min-w-0 flex-1 items-center">
      <Search className="pointer-events-none absolute left-2 size-3 shrink-0 opacity-50" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder="Search conversations..."
        aria-label="Search conversations"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          if (!value && releaseEmptyEscape) return;
          event.preventDefault();
          event.stopPropagation();
          if (value) onChange("");
        }}
        className="h-full w-full min-w-0 rounded-md bg-transparent py-0 pl-7 pr-2 text-[12px] text-content outline-none placeholder:text-content/35"
      />
    </div>
  );
}

/** Icon button beside the search box (filter, refresh). */
export function SessionsHeaderButton({
  label,
  active = false,
  open = false,
  hasPopup = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  open?: boolean;
  hasPopup?: boolean;
  disabled?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      // Only a button that opens a menu has an expanded state; Refresh has
      // none and must not be read as "collapsed".
      aria-expanded={hasPopup ? open : undefined}
      aria-haspopup={hasPopup ? "menu" : undefined}
      disabled={disabled}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      className={`relative z-50 grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content disabled:opacity-50 ${
        open || active ? "bg-selection text-content" : ""
      }`}
    >
      {children}
    </button>
  );
}
