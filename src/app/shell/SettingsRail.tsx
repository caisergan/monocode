import {
  Archive,
  ArrowLeft,
  Bot,
  Inbox,
  FolderTree,
  Globe,
  Internet,
  Keyboard,
  MessageSquare,
  Palette,
  SlidersHorizontal,
  Sparkles,
} from "../../shared/ui/icons";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { Phone } from "../../features/mobile/ui/icons";
import {
  settingsSectionsByGroup,
  type SettingsSectionId,
} from "../../features/settings/model/settings";
import type { ComponentType } from "react";

/** A chrome icon, or a feature glyph drawn like one (Mobile's phone). */
type RailIcon = ComponentType<{ className?: string; strokeWidth?: number }>;

const SECTION_ICONS: Record<SettingsSectionId, RailIcon> = {
  general: SlidersHorizontal,
  connections: Internet,
  mobile: Phone,
  appearance: Palette,
  keybindings: Keyboard,
  chat: MessageSquare,
  providers: Bot,
  mcp: Globe,
  skills: Sparkles,
  inbox: Inbox,
  worktrees: FolderTree,
  archive: Archive,
};

type Props = {
  section: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
  onClose: () => void;
};

/** Body of the project rail while settings are open. */
export function SettingsNav({ section, onSelect, onClose }: Props) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();

  return (
    <>
      <div
        ref={lockOverscroll}
        aria-label="Settings"
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-none px-2 py-3"
      >
        {settingsSectionsByGroup().map((group) => (
          <div key={group.id} className="flex flex-col gap-px">
            <div className="px-2 pb-1 text-xs font-semibold text-content/35">
              {group.label}
            </div>
            {group.sections.map((item) => (
              <NavRow
                key={item.id}
                label={item.label}
                icon={SECTION_ICONS[item.id]}
                active={item.id === section}
                onClick={() => onSelect(item.id)}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex shrink-0 flex-col gap-px p-2">
        <NavRow label="Back" icon={ArrowLeft} onClick={onClose} />
      </div>
    </>
  );
}

function NavRow({
  label,
  icon: Icon,
  active = false,
  onClick,
}: {
  label: string;
  icon: RailIcon;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
        active
          ? "bg-selection text-content"
          : "text-content/50 hover:bg-content/5 hover:text-content"
      }`}
    >
      <Icon className="size-4 shrink-0 opacity-70" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">
        {label}
      </span>
    </button>
  );
}
