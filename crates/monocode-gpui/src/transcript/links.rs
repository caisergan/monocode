//! AgentMarkdown's file-link actions, with browser actions for web links.
use super::*;
use crate::popover::{Menu, MenuAction, MenuEvent, MenuItem, menu_popover};
use gpui::{AnyElement, Entity, Point, Subscription};
use monocode_core::files;
use std::path::Path;
use std::time::Duration;

/// How long a failed file action stays on screen.
const ERROR_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
pub(super) struct State {
    pub(super) open: Option<OpenMenu>,
    error: Option<LinkError>,
    /// Bumped per error so an older timer cannot hide a newer one.
    error_id: usize,
}
struct LinkError {
    id: usize,
    title: String,
    message: String,
}
/// Short heading and body for a failed open or reveal.
fn describe_error(external: bool, path: &str, error: &str) -> (String, String) {
    let title = if external {
        "Couldn't open the file"
    } else if cfg!(target_os = "macos") {
        "Couldn't reveal in Finder"
    } else if cfg!(target_os = "windows") {
        "Couldn't reveal in File Explorer"
    } else {
        "Couldn't open the containing folder"
    };
    let name = Path::new(path)
        .file_name()
        .map_or_else(|| path.to_owned(), |name| name.to_string_lossy().into_owned());
    let message = if error.ends_with("No such file or directory") {
        format!("{name} no longer exists. It may have been moved or deleted.")
    } else {
        format!("{name}: {error}")
    };
    (title.into(), message)
}
pub(super) struct OpenMenu {
    position: Point<Pixels>,
    menu: Entity<Menu>,
    _events: Subscription,
}
enum Target {
    File {
        path: String,
        location: Option<(usize, usize)>,
        base: Option<String>,
    },
    Web(String),
}
impl Target {
    fn resolve(url: &str, base: Option<&str>) -> Option<Self> {
        let lower = url.to_ascii_lowercase();
        if lower.starts_with("https://")
            || lower.starts_with("http://")
            || lower.starts_with("mailto:")
        {
            return Some(Self::Web(url.into()));
        }
        if url.is_empty()
            || url.starts_with(['#', '?'])
            || (url.contains("://") && !url.starts_with("file://"))
        {
            return None;
        }
        let (path, location) = crate::file_editor::file_location(url, base.unwrap_or(""));
        // A connected machine's files open from a local copy.
        if !Path::new(&path).is_absolute() && !path.starts_with("remote://") {
            return None;
        }
        Some(Self::File {
            path,
            location,
            base: base.map(str::to_owned),
        })
    }
    fn items(&self) -> Vec<MenuItem> {
        match self {
            Self::Web(_) => vec![
                MenuAction::new("open-web", "Open Link").into(),
                MenuAction::new("copy-link", "Copy Link Address").into(),
            ],
            Self::File { base, path, .. } => {
                let reveal = if cfg!(target_os = "macos") {
                    "Reveal in Finder"
                } else if cfg!(target_os = "windows") {
                    "Reveal in File Explorer"
                } else {
                    "Open Containing Folder"
                };
                let mut items = vec![
                    MenuAction::new("open-monocode", "Open in MonoCode").into(),
                    MenuAction::new("open-default", "Open in Default App").into(),
                    // A remote file has no folder on this computer to show.
                    MenuAction::new("reveal", reveal)
                        .disabled(path.starts_with("remote://"))
                        .into(),
                    MenuItem::Separator,
                    MenuAction::new("copy-path", "Copy Path").into(),
                ];
                if base.is_some() {
                    items.push(MenuAction::new("copy-relative-path", "Copy Relative Path").into());
                }
                items
            }
        }
    }
}
impl TranscriptView {
    pub(super) fn open_link_menu(
        &mut self,
        request: &markdown::LinkMenu,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(target) = Target::resolve(&request.url, self.file_link_base.as_deref()) else {
            return;
        };
        self.selection.hide_menu();
        self.links.error = None;
        self.links.open = None;
        // Replacing an open menu must restore to the transcript, rather than
        // retaining a focus handle owned by the menu that is being discarded.
        if let Some(focus) = &self.selection_focus {
            window.focus(focus, cx);
        }
        let label = if matches!(&target, Target::File { .. }) {
            "File link actions"
        } else {
            "Link actions"
        };
        let menu = cx.new(|cx| Menu::new(label, target.items(), window, cx));
        let events = cx.subscribe_in(
            &menu,
            window,
            move |this, _, event: &MenuEvent, window, cx| {
                this.links.open = None;
                if let MenuEvent::Picked(id, _) = event {
                    this.run_link_action(id, &target, window, cx);
                }
                cx.notify();
            },
        );
        self.links.open = Some(OpenMenu {
            position: request.position,
            menu,
            _events: events,
        });
        cx.stop_propagation();
        cx.notify();
    }
    fn run_link_action(
        &mut self,
        action: &str,
        target: &Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match (action, target) {
            ("open-web", Target::Web(url)) => cx.open_url(url),
            ("copy-link", Target::Web(url)) => {
                cx.write_to_clipboard(ClipboardItem::new_string(url.clone()))
            }
            ("open-monocode", Target::File { path, location, .. }) => {
                let target = location.map_or_else(
                    || path.clone(),
                    |(line, column)| format!("{path}:{line}:{column}"),
                );
                window.dispatch_action(Box::new(crate::file_editor::OpenPath(target)), cx);
            }
            ("copy-path", Target::File { path, .. }) => {
                cx.write_to_clipboard(ClipboardItem::new_string(path.clone()))
            }
            ("copy-relative-path", Target::File { path, base, .. }) => cx.write_to_clipboard(
                ClipboardItem::new_string(files::display_path(path, base.as_deref())),
            ),
            ("open-default" | "reveal", Target::File { path, .. }) => {
                let path = path.clone();
                let external = action == "open-default";
                let work = cx.background_executor().spawn({
                    let path = path.clone();
                    async move {
                        if external {
                            files::open_path_with_default_app(Path::new(&path))
                        } else {
                            files::reveal_path(Path::new(&path))
                        }
                    }
                });
                cx.spawn(async move |this, cx| {
                    if let Err(error) = work.await {
                        let _ = this.update(cx, |this, cx| {
                            let (title, message) = describe_error(external, &path, &error);
                            this.show_link_error(title, message, cx);
                        });
                    }
                })
                .detach();
            }
            _ => {}
        }
    }
    fn show_link_error(&mut self, title: String, message: String, cx: &mut Context<Self>) {
        self.links.error_id += 1;
        let id = self.links.error_id;
        self.links.error = Some(LinkError { id, title, message });
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(ERROR_TIMEOUT).await;
            let _ = this.update(cx, |this, cx| {
                if this.links.error.as_ref().is_some_and(|error| error.id == id) {
                    this.links.error = None;
                    cx.notify();
                }
            });
        })
        .detach();
    }
    pub(super) fn link_overlays(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .absolute()
            .inset_0()
            .when_some(self.links.open.as_ref(), |d, open| {
                d.child(
                    menu_popover(&open.menu, Anchor::Point(open.position), cx)
                        .allow_outside_press(),
                )
            })
            .when_some(self.links.error.as_ref(), |d, error| {
                d.child(
                    div()
                        .absolute()
                        .left(px(16.))
                        .right(px(16.))
                        .bottom(px(16.))
                        .flex()
                        .justify_end()
                        .child(
                            div().w(px(360.)).max_w_full().child(
                                crate::notifications::errors::titled_card(
                                    "transcript-link-error",
                                    error.title.clone(),
                                    error.message.clone(),
                                    icon_button(
                                        "dismiss-link-error",
                                        "Dismiss file action error",
                                        "close",
                                    )
                                    .debug_selector(|| "dismiss-link-error".into())
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.links.error = None;
                                        cx.notify();
                                    })),
                                ),
                            ),
                        ),
                )
            })
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{TestAppContext, VisualTestContext, WindowBounds, WindowOptions, point};

    #[test]
    fn missing_file_names_the_file_not_the_whole_path() {
        let path = "/Users/me/Desktop/project/docs/plan.md";
        let error = format!("{path}: No such file or directory");
        let (title, message) = describe_error(false, path, &error);
        assert!(title.starts_with("Couldn't "));
        assert_eq!(
            message,
            "plan.md no longer exists. It may have been moved or deleted."
        );
        let (title, message) = describe_error(true, path, "No application could open this file.");
        assert_eq!(title, "Couldn't open the file");
        assert_eq!(message, "plan.md: No application could open this file.");
    }

    #[gpui::test]
    fn link_error_fits_the_transcript_and_hides_after_five_seconds(cx: &mut TestAppContext) {
        let window = cx.update(|cx| {
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        point(px(0.), px(0.)),
                        size(px(900.), px(700.)),
                    ))),
                    ..Default::default()
                },
                |_, cx| cx.new(|_| TranscriptView::new()),
            )
            .unwrap()
        });
        let visual = &mut VisualTestContext::from_window(window.into(), cx);
        let long = format!("/Users/me/{}plan.md", "very-long-folder-name/".repeat(12));
        window
            .update(visual, |view, _, cx| {
                let (title, message) = describe_error(false, &long, &long);
                view.show_link_error(title, message, cx);
            })
            .unwrap();
        visual.run_until_parked();
        visual.refresh().unwrap();
        let card = visual.debug_bounds("transcript-link-error").unwrap();
        assert_eq!(card.size.width, px(360.));
        assert_eq!(card.right(), px(900. - 16.));
        assert!(visual.debug_bounds("dismiss-link-error").is_some());

        // A narrow transcript shrinks the card instead of pushing it off-screen.
        visual.simulate_resize(size(px(300.), px(700.)));
        visual.run_until_parked();
        visual.refresh().unwrap();
        let card = visual.debug_bounds("transcript-link-error").unwrap();
        assert_eq!(card.left(), px(16.));
        assert_eq!(card.right(), px(300. - 16.));

        visual.executor().advance_clock(Duration::from_millis(4900));
        visual.run_until_parked();
        visual.refresh().unwrap();
        assert!(visual.debug_bounds("transcript-link-error").is_some());
        visual.executor().advance_clock(Duration::from_millis(200));
        visual.run_until_parked();
        visual.refresh().unwrap();
        assert!(visual.debug_bounds("transcript-link-error").is_none());
    }

    #[gpui::test]
    fn a_newer_error_gets_its_own_five_seconds(cx: &mut TestAppContext) {
        let window = cx.update(|cx| {
            cx.open_window(Default::default(), |_, cx| cx.new(|_| TranscriptView::new()))
                .unwrap()
        });
        let show = |cx: &mut TestAppContext, text: &str| {
            window
                .update(cx, |view, _, cx| {
                    view.show_link_error("Couldn't".into(), text.into(), cx)
                })
                .unwrap();
        };
        show(cx, "first");
        cx.executor().advance_clock(Duration::from_secs(3));
        show(cx, "second");
        cx.executor().advance_clock(Duration::from_secs(3));
        cx.run_until_parked();
        let shown = window
            .update(cx, |view, _, _| view.links.error.as_ref().map(|e| e.message.clone()))
            .unwrap();
        assert_eq!(shown.as_deref(), Some("second"));
        cx.executor().advance_clock(Duration::from_secs(3));
        cx.run_until_parked();
        let shown = window
            .update(cx, |view, _, _| view.links.error.is_some())
            .unwrap();
        assert!(!shown);
    }
}
