//! Pairs a phone with one of this desktop's machines, so the phone carries on
//! with the machine's sessions while this computer sleeps. The machine's host
//! makes the one-use code, and the phone reaches it through Tailscale Serve;
//! the code shows in the same dialog that pairs a phone with this desktop.
use super::mobile::{PairingBody, PairingDialog};
use crate::{
    settings::{
        SettingsView,
        widgets::{red, secondary_button},
    },
    theme::*,
};
use gpui::{
    AnyElement, Context, FontWeight, ParentElement, Role, SharedString, Task, div, prelude::*, px,
};
use serde_json::{Value, json};
use std::time::Duration;

/// How often the dialog asks the host whether the phone has paired.
const STATUS_POLL: Duration = Duration::from_secs(2);

/// A phone being paired with `machine`, by its saved connection's ID.
pub(in crate::settings) struct PhonePairing {
    machine: String,
    name: String,
    state: PhoneState,
    busy: bool,
    error: Option<String>,
    poll: Option<Task<()>>,
}

#[derive(Clone, Debug, PartialEq)]
enum PhoneState {
    Loading,
    Code {
        code: String,
        link: String,
        url: String,
        expires: u64,
        secure: bool,
    },
    /// Tailscale is up; Serve has to forward the tailnet to the host first.
    Serve { secure: bool, command: String },
    /// Tailscale is installed on the machine but not connected.
    Stopped,
    /// No Tailscale on the machine.
    Missing,
}

/// The host's `phones.invite` answer: a code and its link, or what keeps a
/// phone from reaching the machine yet.
fn invite_state(value: &Value) -> Result<PhoneState, String> {
    let reach = &value["reach"];
    if let (Some(link), Some(url)) = (value["link"].as_str(), value["url"].as_str()) {
        return Ok(PhoneState::Code {
            code: value["code"].as_str().ok_or("Host sent no code")?.into(),
            link: link.into(),
            url: url.into(),
            expires: value["expires"].as_u64().ok_or("Host sent no expiry")?,
            secure: url.starts_with("https://"),
        });
    }
    match reach["state"].as_str() {
        Some("serve") => Ok(PhoneState::Serve {
            secure: reach["secure"] == true,
            command: reach["command"]
                .as_array()
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default(),
        }),
        Some("stopped") => Ok(PhoneState::Stopped),
        Some("missing") => Ok(PhoneState::Missing),
        _ => Err("The machine sent an unexpected answer. Update Host and try again.".into()),
    }
}

impl SettingsView {
    pub(super) fn machine_phone_open(&self) -> bool {
        self.connections.phone.is_some()
    }

    /// Pair phone, for the machine saved as `machine`.
    pub(super) fn pair_machine_phone(&mut self, machine: String, cx: &mut Context<Self>) {
        let name = self
            .connections
            .machines
            .iter()
            .find(|entry| entry.id == machine)
            .map(|entry| entry.name.clone())
            .unwrap_or_else(|| "this machine".into());
        self.connections.notice.clear();
        self.connections.phone = Some(PhonePairing {
            machine,
            name,
            state: PhoneState::Loading,
            busy: false,
            error: None,
            poll: None,
        });
        self.request_machine_invite(cx);
    }

    pub(super) fn close_machine_phone(&mut self, cx: &mut Context<Self>) {
        self.connections.phone = None;
        cx.notify();
    }

    /// Asks the host for a new code, which replaces the one showing.
    fn request_machine_invite(&mut self, cx: &mut Context<Self>) {
        let (Some(remote), Some(phone)) = (self.ctx.remote.clone(), self.connections.phone.as_mut())
        else {
            return;
        };
        if phone.busy {
            return;
        }
        phone.busy = true;
        phone.error = None;
        phone.poll = None;
        let machine = phone.machine.clone();
        let work = cx.background_executor().spawn({
            let machine = machine.clone();
            async move { remote.request(&machine, "phones.invite", json!({})) }
        });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |this, cx| {
                let Some(phone) = this.connections.phone.as_mut().filter(|p| p.machine == machine)
                else {
                    return;
                };
                phone.busy = false;
                match result.and_then(|value| invite_state(&value)) {
                    Ok(state) => {
                        let code = match &state {
                            PhoneState::Code { code, .. } => Some(code.clone()),
                            _ => None,
                        };
                        phone.state = state;
                        if let Some(code) = code {
                            this.watch_machine_invite(code, cx);
                        }
                    }
                    Err(error) => {
                        phone.error = Some(error);
                        if phone.state == PhoneState::Loading {
                            phone.state = PhoneState::Missing;
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// Until the phone pairs, asks the host every few seconds whether it has;
    /// then says so on the page and closes the code.
    fn watch_machine_invite(&mut self, code: String, cx: &mut Context<Self>) {
        let (Some(remote), Some(phone)) = (self.ctx.remote.clone(), self.connections.phone.as_mut())
        else {
            return;
        };
        let machine = phone.machine.clone();
        phone.poll = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(STATUS_POLL).await;
                let status = cx
                    .background_executor()
                    .spawn({
                        let (remote, machine, code) = (remote.clone(), machine.clone(), code.clone());
                        async move {
                            remote.request(&machine, "phones.inviteStatus", json!({"code": code}))
                        }
                    })
                    .await;
                let done = this
                    .update(cx, |this, cx| {
                        let Some(phone) = this.connections.phone.as_ref() else {
                            return true;
                        };
                        let Some(paired) = status.ok().and_then(|value| {
                            value["paired"].as_str().map(str::to_owned)
                        }) else {
                            return false;
                        };
                        this.connections.notice = format!(
                            "{paired} is paired with {}. It works with the machine even while this computer sleeps.",
                            phone.name
                        );
                        this.connections.phone = None;
                        cx.notify();
                        true
                    })
                    .unwrap_or(true);
                if done {
                    break;
                }
            }
        }));
    }

    /// Turns on Tailscale Serve on the machine, then makes the code.
    fn serve_machine_phone(&mut self, cx: &mut Context<Self>) {
        let (Some(remote), Some(phone)) = (self.ctx.remote.clone(), self.connections.phone.as_mut())
        else {
            return;
        };
        if phone.busy {
            return;
        }
        phone.busy = true;
        phone.error = None;
        let machine = phone.machine.clone();
        let work = cx.background_executor().spawn({
            let machine = machine.clone();
            async move { remote.request(&machine, "phones.serve", json!({})) }
        });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |this, cx| {
                let Some(phone) = this.connections.phone.as_mut().filter(|p| p.machine == machine)
                else {
                    return;
                };
                phone.busy = false;
                match result {
                    Ok(_) => this.request_machine_invite(cx),
                    Err(error) => phone.error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// The pairing dialog's content for the machine being paired, if one is.
    pub(super) fn machine_phone_dialog(&mut self, cx: &mut Context<Self>) -> Option<PairingDialog> {
        let phone = self.connections.phone.as_ref()?;
        let name = phone.name.clone();
        let busy = phone.busy;
        let error = phone.error.clone();
        let (body, footnote) = match phone.state.clone() {
            PhoneState::Code {
                link,
                url,
                expires,
                secure,
                ..
            } => (
                PairingBody::Code { url: link, expires },
                format!(
                    "Your phone reaches {name} at {url} through Tailscale, so this computer can sleep. \
                     Install Tailscale on the phone and sign in to the same tailnet. {}Each code works once.",
                    if secure { "" } else { "Its traffic stays inside the tailnet. " }
                ),
            ),
            state => (
                PairingBody::Setup(self.machine_phone_setup(&name, &state, busy, error.clone(), cx)),
                "MonoCode never opens the machine to the internet: Tailscale Serve forwards your tailnet to the host’s own port."
                    .into(),
            ),
        };
        Some(PairingDialog {
            title: format!("Connect a phone to {name}"),
            tail: ", and scan the code. Paired already? Use Settings → Pair a desktop or machine.".into(),
            body,
            footnote,
            busy,
            new_code: |this, cx| this.request_machine_invite(cx),
            close: |this, cx| this.close_machine_phone(cx),
        })
    }

    /// In the code's place: what the machine needs before a phone can reach it.
    fn machine_phone_setup(
        &self,
        name: &str,
        state: &PhoneState,
        busy: bool,
        error: Option<String>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (heading, text, action): (String, String, Option<(&'static str, bool)>) = match state {
            PhoneState::Loading => (
                format!("Checking {name}…"),
                "Asking the machine how a phone can reach it.".into(),
                None,
            ),
            PhoneState::Serve { secure, .. } => (
                "Turn on Tailscale Serve".into(),
                format!(
                    "Your phone reaches {name} through Tailscale. Serve forwards your tailnet to the MonoCode host there.{}",
                    if *secure {
                        ""
                    } else {
                        " Without the tailnet’s HTTPS certificates it uses plain HTTP, which only travels inside the encrypted tailnet."
                    }
                ),
                Some(("Turn on Serve", true)),
            ),
            PhoneState::Stopped => (
                format!("Connect {name} to Tailscale"),
                format!("Tailscale is installed on {name} but not signed in. Run sudo tailscale up there, then check again."),
                Some(("Check again", false)),
            ),
            PhoneState::Missing | PhoneState::Code { .. } => (
                format!("Install Tailscale on {name}"),
                format!("Your phone reaches {name} through Tailscale. Install it on the machine and on your phone, sign both in to the same tailnet, then check again."),
                Some(("Check again", false)),
            ),
        };
        let command = match state {
            PhoneState::Serve { command, .. } if !command.is_empty() => Some(format!("sudo {command}")),
            _ => None,
        };
        div()
            .id("machine-phone-setup")
            .debug_selector(|| "machine-phone-setup".into())
            .role(Role::Status)
            .w_full()
            .rounded_2xl()
            .border_1()
            .border_color(content(0.1))
            .bg(content(0.03))
            .p_5()
            .flex()
            .flex_col()
            .items_center()
            .gap_3()
            .child(icon(if busy { "loader" } else { "globe" }, 28.).text_color(content(0.55)))
            .child(
                div()
                    .text_size(px(15.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(content(1.))
                    .child(heading),
            )
            .child(
                div()
                    .text_center()
                    .text_size(px(12.))
                    .line_height(px(19.5))
                    .text_color(content(0.55))
                    .child(text),
            )
            .when_some(command, |d, command| {
                d.child(
                    div()
                        .max_w_full()
                        .rounded_md()
                        .bg(content(0.06))
                        .px_2()
                        .py_1()
                        .font_family(crate::fonts::mono())
                        .text_size(px(11.))
                        .text_color(content(0.6))
                        .child(SharedString::from(command)),
                )
            })
            .when_some(error, |d, error| {
                d.child(
                    div()
                        .id("machine-phone-error")
                        .role(Role::Alert)
                        .w_full()
                        .rounded_lg()
                        .bg(red(0.05))
                        .p_3()
                        .text_size(px(12.))
                        .line_height(px(19.5))
                        .text_color(red(1.))
                        .child(error),
                )
            })
            .when_some(action, |d, (label, serve)| {
                d.child(
                    secondary_button("machine-phone-action", label, false, busy)
                        .child(if busy {
                            if serve { "Turning on…" } else { "Checking…" }
                        } else {
                            label
                        })
                        .when(!busy, |b| {
                            b.on_click(cx.listener(move |this, _, _, cx| {
                                if serve {
                                    this.serve_machine_phone(cx)
                                } else {
                                    this.request_machine_invite(cx)
                                }
                            }))
                        }),
                )
            })
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_invite_is_a_code_or_what_the_machine_needs_first() {
        let code = invite_state(&json!({
            "code": "abc", "expires": 100, "url": "http://box.tailnet.ts.net:3774",
            "link": "monocode://pair?i=x", "reach": {"state": "ready"},
        }))
        .unwrap();
        assert_eq!(
            code,
            PhoneState::Code {
                code: "abc".into(),
                link: "monocode://pair?i=x".into(),
                url: "http://box.tailnet.ts.net:3774".into(),
                expires: 100,
                secure: false,
            }
        );
        assert_eq!(
            invite_state(&json!({"link": null, "url": null, "reach": {
                "state": "serve", "secure": true,
                "command": ["tailscale", "serve", "--bg", "--https=443", "http://127.0.0.1:3774"],
            }}))
            .unwrap(),
            PhoneState::Serve {
                secure: true,
                command: "tailscale serve --bg --https=443 http://127.0.0.1:3774".into(),
            }
        );
        assert_eq!(
            invite_state(&json!({"link": null, "reach": {"state": "stopped"}})).unwrap(),
            PhoneState::Stopped
        );
        assert!(invite_state(&json!({"reach": {}})).is_err());
    }
}
