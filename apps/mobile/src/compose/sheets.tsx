// The composer's sheets (11 §11.17): model, access and Add to message.

import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { HARNESS_LABEL, RUNTIME_MODES, RUNTIME_MODE_HINT, RUNTIME_MODE_LABEL } from "@monocode/core/session";
import type { HostModelCatalog, RemoteProvider, RuntimeMode } from "@monocode/core/session";
import { RADII, TYPE } from "@monocode/design";
import { Icon, type IconName } from "@/ui/icon";
import { Sheet, SheetCaption, SheetRow, SheetSwitch } from "@/ui/sheet";
import { useTokens } from "@/ui/theme";
import { findModel, mergeSettings, orderedSettings, type CatalogModel, type ComposerConfig } from "./models";

export const ACCESS_ICON: Record<RuntimeMode, IconName> = {
  supervised: "lock",
  "auto-accept-edits": "pencil",
  auto: "sparkles",
  "full-access": "shield",
};

/** The access sheet (11 §11.17, QuickPermissions). Full access asks first (D16). */
export function AccessSheet({
  visible,
  onClose,
  value,
  onChange,
  running,
}: {
  visible: boolean;
  onClose: () => void;
  value: RuntimeMode;
  onChange: (mode: RuntimeMode) => void;
  running: boolean;
}) {
  const t = useTokens();
  const choose = (mode: RuntimeMode) => {
    if (mode !== "full-access" || value === "full-access") {
      onChange(mode);
      onClose();
      return;
    }
    Alert.alert("Allow full access?", "The agent will run commands and edit files without asking.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Allow full access",
        style: "destructive",
        onPress: () => {
          onChange("full-access");
          onClose();
        },
      },
    ]);
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Access">
      {running ? <SheetCaption>Access changes apply to the next turn. Stop and resend to apply them now.</SheetCaption> : null}
      {RUNTIME_MODES.map((mode) => (
        <SheetRow
          key={mode}
          icon={ACCESS_ICON[mode]}
          iconColor={mode === "full-access" ? t.status.attention : undefined}
          label={RUNTIME_MODE_LABEL[mode]}
          hint={RUNTIME_MODE_HINT[mode]}
          checked={mode === value}
          onPress={() => choose(mode)}
        />
      ))}
    </Sheet>
  );
}

function SettingRows({ model, values, onChange }: { model: CatalogModel; values: Record<string, string>; onChange: (id: string, value: string) => void }) {
  const t = useTokens();
  const [open, setOpen] = useState<string>();
  return (
    <>
      {orderedSettings(model).map((setting) => {
        const value = values[setting.id] ?? setting.value;
        if (setting.kind === "toggle")
          return (
            <SheetSwitch
              key={setting.id}
              label={setting.label}
              hint={setting.description}
              value={value === "true"}
              onChange={(on) => onChange(setting.id, on ? "true" : "false")}
            />
          );
        const label = setting.options.find((option) => option.value === value)?.label ?? value;
        return (
          <View key={setting.id}>
            <SheetRow
              label={setting.label}
              hint={setting.description}
              right={<Text style={{ color: t.text.secondary, fontSize: TYPE.secondary.size }}>{label}</Text>}
              onPress={() => setOpen(open === setting.id ? undefined : setting.id)}
            />
            {open === setting.id
              ? setting.options.map((option) => (
                  <View key={option.value} style={{ paddingLeft: 20 }}>
                    <SheetRow
                      label={option.label}
                      checked={option.value === value}
                      onPress={() => {
                        onChange(setting.id, option.value);
                        setOpen(undefined);
                      }}
                    />
                  </View>
                ))
              : null}
          </View>
        );
      })}
    </>
  );
}

/** The model sheet: the model's settings first, then the model list. */
export function ModelSheet({
  visible,
  onClose,
  catalog,
  loading,
  error,
  providers,
  harnessLocked,
  config,
  onChange,
  running,
  favorites,
  onFavorite,
}: {
  visible: boolean;
  onClose: () => void;
  catalog?: HostModelCatalog;
  loading: boolean;
  error?: string;
  providers: RemoteProvider[];
  /** The provider is fixed once the session has started. */
  harnessLocked: boolean;
  config: ComposerConfig;
  onChange: (config: ComposerConfig) => void;
  running: boolean;
  favorites: string[];
  onFavorite: (modelId: string) => void;
}) {
  const t = useTokens();
  const [view, setView] = useState<"settings" | "models">("settings");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<RemoteProvider | "favorites">(config.harness);
  const model = findModel(catalog, config.harness, config.model);
  const strip: (RemoteProvider | "favorites")[] = ["favorites", ...(harnessLocked ? [config.harness] : providers)];
  const allowed = harnessLocked ? [config.harness] : providers;
  const candidates =
    tab === "favorites"
      ? allowed.flatMap((harness) => (catalog?.models[harness] ?? []).filter((item) => favorites.includes(item.id)))
      : (catalog?.models[tab] ?? []);
  const needle = query.trim().toLowerCase();
  const list = needle ? candidates.filter((item) => item.name.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle)) : candidates;
  const providerError = tab !== "favorites" ? catalog?.errors[tab] : undefined;

  const pick = (next: CatalogModel) => {
    onChange({ ...config, harness: next.harness as RemoteProvider, model: next.id, modelSettings: mergeSettings(next, config.modelSettings) });
    setView("settings");
  };

  const close = () => {
    setView("settings");
    setQuery("");
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={close} title={view === "models" ? "Models" : "Model"} scroll={view === "settings"}>
      {view === "settings" ? (
        <>
          {running ? <SheetCaption>Changes apply to the next turn.</SheetCaption> : null}
          {error ? <SheetCaption>{error}</SheetCaption> : null}
          {model ? (
            <SettingRows model={model} values={config.modelSettings} onChange={(id, value) => onChange({ ...config, modelSettings: { ...config.modelSettings, [id]: value } })} />
          ) : null}
          <SheetRow
            label="Model"
            right={<Text style={{ color: t.text.secondary, fontSize: TYPE.secondary.size }}>{model?.name ?? config.model}</Text>}
            onPress={() => {
              setTab(config.harness);
              setView("models");
            }}
          />
        </>
      ) : (
        <View style={{ flex: 1 }}>
          <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search models"
              placeholderTextColor={t.text.faint}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              style={{ height: 36, paddingHorizontal: 12, borderRadius: RADII.md, backgroundColor: t.fill.chip, color: t.content, fontSize: TYPE.row.size }}
            />
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 12, gap: 6, paddingBottom: 8 }}>
            {strip.map((item) => (
              <Pressable
                key={item}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === item }}
                accessibilityLabel={item === "favorites" ? "Favorites" : HARNESS_LABEL[item]}
                onPress={() => setTab(item)}
                style={{
                  height: 30,
                  paddingHorizontal: 10,
                  borderRadius: RADII.md,
                  justifyContent: "center",
                  backgroundColor: tab === item ? t.selection.hover : t.fill.chip,
                }}
              >
                {item === "favorites" ? (
                  <Icon name="star.fill" size={13} color={t.status.attention} />
                ) : (
                  <Text style={{ color: t.contentAlpha(0.8), fontSize: 13 }}>{HARNESS_LABEL[item]}</Text>
                )}
              </Pressable>
            ))}
          </ScrollView>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }}>
            {list.map((item) => (
              <SheetRow
                key={item.id}
                label={item.name}
                checked={item.id === config.model && item.harness === config.harness}
                onPress={() => pick(item)}
                right={
                  <Pressable accessibilityLabel={favorites.includes(item.id) ? "Remove from favorites" : "Add to favorites"} hitSlop={10} onPress={() => onFavorite(item.id)}>
                    <Icon name={favorites.includes(item.id) ? "star.fill" : "star"} size={15} color={favorites.includes(item.id) ? t.status.attention : t.contentAlpha(0.35)} />
                  </Pressable>
                }
              />
            ))}
            {!list.length ? (
              <SheetCaption>
                {providerError
                  ? providerError
                  : loading && tab !== "favorites"
                    ? `Loading ${HARNESS_LABEL[tab]} models…`
                    : tab === "favorites" && !needle
                      ? "No favorite models"
                      : "No matching models"}
              </SheetCaption>
            ) : null}
          </ScrollView>
        </View>
      )}
    </Sheet>
  );
}

/** Add to message (11 §11.17 +). */
export function AddSheet({
  visible,
  onClose,
  canAttach,
  canPlan,
  canDraft,
  onCamera,
  onLibrary,
  onPlan,
  onDraft,
}: {
  visible: boolean;
  onClose: () => void;
  canAttach: boolean;
  canPlan: boolean;
  canDraft: boolean;
  onCamera: () => void;
  onLibrary: () => void;
  onPlan: () => void;
  onDraft: () => void;
}) {
  const [upload, setUpload] = useState(false);
  const close = () => {
    setUpload(false);
    onClose();
  };
  return (
    <Sheet visible={visible} onClose={close} title="Add to message">
      <SheetRow
        icon="paperclip"
        label="Upload file"
        hint={canAttach ? "Attach files or images" : "Update this machine’s host to attach files"}
        disabled={!canAttach}
        onPress={() => setUpload(!upload)}
      />
      {upload && canAttach ? (
        <View style={{ paddingLeft: 20 }}>
          <SheetRow icon="camera" label="Camera" onPress={onCamera} />
          <SheetRow icon="photo.on.rectangle" label="Photo library" onPress={onLibrary} />
        </View>
      ) : null}
      {canPlan ? <SheetRow icon="lightbulb" iconColor="rgba(253,224,71,0.8)" label="Plan mode" hint="Review a plan before building" onPress={onPlan} /> : null}
      {canDraft ? <SheetRow icon="circle.dashed" label="Draft" hint="Save this message without starting the agent" onPress={onDraft} /> : null}
    </Sheet>
  );
}
