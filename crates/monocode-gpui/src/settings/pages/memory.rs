//! What Hermes remembers between chats: its picture of the user and its own
//! notes, an entry a row, each one forgettable. Hermes writes these itself as
//! it works; this page reads them and takes entries out, nothing else.
use crate::{
    settings::{
        SettingsView,
        widgets::{icon_action, note, secondary_button},
    },
    theme::*,
};
use gpui::{AnyElement, Context, SharedString, div, prelude::*, px, rgb};
use monocode_core::hermes_memory::{self, Kind, Store};

/// The page's state: Hermes's stores as last read from disk.
#[derive(Default)]
pub(in crate::settings) struct MemoryState {
    loaded: bool,
    /// `None`: Hermes keeps no memory on this machine.
    stores: Option<Vec<Store>>,
    /// The entry a first click on Forget asked about.
    armed: Option<(Kind, usize)>,
    error: Option<String>,
    /// Hermes's home in place of the user's, for tests.
    pub(in crate::settings) home: Option<std::path::PathBuf>,
}

impl SettingsView {
    /// Read the stores again: on opening the page, on Refresh, after a change.
    pub(in crate::settings) fn load_memory(&mut self) {
        self.memory.loaded = true;
        self.memory.armed = None;
        self.memory.stores = self
            .memory_home()
            .and_then(|home| hermes_memory::load(&home));
    }
    fn memory_home(&self) -> Option<std::path::PathBuf> {
        self.memory.home.clone().or_else(hermes_memory::home)
    }

    fn forget_memory(&mut self, kind: Kind, index: usize, cx: &mut Context<Self>) {
        if self.memory.armed != Some((kind, index)) {
            // Forgetting cannot be taken back: the first click only asks.
            self.memory.armed = Some((kind, index));
            self.memory.error = None;
            cx.notify();
            return;
        }
        let entry = self
            .memory
            .stores
            .iter()
            .flatten()
            .find(|store| store.kind == kind)
            .and_then(|store| store.entries.get(index).cloned());
        // Hermes may hold the file's lock while it writes: waiting for it
        // is not the window's to do.
        let home = self.memory_home();
        self.memory.armed = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match (home, entry) {
                        (Some(home), Some(entry)) => hermes_memory::remove(&home, kind, &entry),
                        _ => Err("Hermes's memory could not be found.".into()),
                    }
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.load_memory();
                this.memory.error = result.err();
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn memory_page(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        if !self.memory.loaded {
            self.load_memory();
        }
        let refresh = icon_action(
            "refresh-memory",
            "Refresh memory",
            "refresh-cw",
            24.,
            14.,
            0.45,
            false,
        )
        .debug_selector(|| "settings-memory-refresh".into())
        .on_click(cx.listener(|this, _, _, cx| {
            this.load_memory();
            this.memory.error = None;
            cx.notify();
        }))
        .into_any_element();
        let Some(stores) = self.memory.stores.clone() else {
            return vec![self.group(
                None,
                true,
                "Hermes memory",
                Some("Hermes keeps no memory on this machine yet.".into()),
                Some(refresh),
                vec![note(
                    "Once Hermes Agent is installed and has something to remember, it shows up here.",
                )],
            )];
        };
        let armed = self.memory.armed;
        let mut refresh = Some(refresh);
        let mut groups = Vec::new();
        if let Some(error) = self.memory.error.clone() {
            groups.push(
                div()
                    .debug_selector(|| "settings-memory-error".into())
                    .pb_3()
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .text_color(rgb(0xf87171))
                    .child(error)
                    .into_any_element(),
            );
        }
        for (at, store) in stores.iter().enumerate() {
            let kind = store.kind;
            let mut rows: Vec<AnyElement> = store
                .entries
                .iter()
                .enumerate()
                .map(|(index, entry)| {
                    let asking = armed == Some((kind, index));
                    let label = if asking { "Forget for good?" } else { "Forget" };
                    div()
                        .flex()
                        .items_start()
                        .gap_3()
                        .when(index > 0, |d| d.border_t_1().border_color(content(0.05)))
                        .px_4()
                        .py(px(10.))
                        .child(
                            div()
                                .min_w_0()
                                .flex_1()
                                .text_size(px(13.))
                                .line_height(px(19.))
                                .text_color(content(0.85))
                                .child(entry.clone()),
                        )
                        .child(
                            secondary_button(
                                SharedString::from(format!("forget-{}-{index}", kind.file())),
                                label,
                                true,
                                false,
                            )
                            .debug_selector(move || {
                                format!("settings-memory-forget-{}-{index}", kind.file())
                            })
                            .flex_shrink_0()
                            .child(label)
                            .on_click(cx.listener(
                                move |this, _, _, cx| this.forget_memory(kind, index, cx),
                            )),
                        )
                        .into_any_element()
                })
                .collect();
            if rows.is_empty() {
                rows.push(note("Nothing here yet."));
            }
            let over = store.used > store.limit;
            let budget = div()
                .flex()
                .items_center()
                .gap_2()
                .child(
                    div()
                        .debug_selector(move || format!("settings-memory-budget-{}", kind.file()))
                        .text_size(px(11.))
                        .text_color(if over {
                            rgb(0xf87171).into()
                        } else {
                            content(0.4)
                        })
                        .child(format!(
                            "{} / {} characters",
                            crate::right_panel::format_integer(store.used as i64),
                            crate::right_panel::format_integer(store.limit as i64)
                        )),
                )
                .child({
                    let path = store.path.clone();
                    secondary_button(
                        SharedString::from(format!("reveal-{}", kind.file())),
                        "Show file",
                        false,
                        false,
                    )
                    .child("Show file")
                    .on_click(move |_, _, cx| cx.reveal_path(&path))
                })
                .children(refresh.take())
                .into_any_element();
            groups.push(self.group(
                None,
                at == 0 && self.memory.error.is_none(),
                kind.title(),
                Some(kind.description().into()),
                Some(budget),
                rows,
            ));
        }
        groups
    }
}
