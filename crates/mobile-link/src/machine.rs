//! A MonoCode host on another machine, reached without the desktop: the same
//! requests and watches the desktop's QUIC link carries, as JSON posted to the
//! host's `/mobile` route with this phone's device credential. The route is
//! the host's loopback port, forwarded to the phone by Tailscale Serve, so it
//! is HTTPS, or plain HTTP that only ever travels inside the tailnet.
use crate::{
    transport::{exchange_timeout, Watch, WatchLink},
    LinkResult, REQUEST_LIMIT, RESPONSE_LIMIT,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::Read,
    net::IpAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    time::Duration,
};
use tokio::sync::{mpsc, Notify};

/// How long one poll of a watch waits on the host for news.
const WATCH_WAIT: Duration = Duration::from_secs(20);
/// Polls that fail to reach the host are retried this often before the watch
/// ends, which reopens it, as across a network change.
const WATCH_RETRIES: u32 = 3;

#[derive(Clone, Debug, Deserialize)]
pub struct HostLink {
    /// Where the host answers, e.g. `https://box.tailnet.ts.net`.
    pub url: String,
    /// This phone's device credential; empty while it pairs.
    #[serde(default)]
    pub token: String,
}

enum Failure {
    /// The host could not be reached; trying again may work.
    Link(String),
    /// The host answered, refusing the request.
    Refused(String),
}
impl From<Failure> for String {
    fn from(failure: Failure) -> Self {
        match failure {
            Failure::Link(error) | Failure::Refused(error) => error,
        }
    }
}

fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(8))
            .max_idle_connections_per_host(4)
            .build()
    })
}

/// The host's `/mobile` route under `url`: HTTPS anywhere, HTTP only to a
/// tailnet name or address, as the host itself checks the links it makes.
pub fn endpoint(url: &str) -> LinkResult<String> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| "Invalid machine address")?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Invalid machine address".into());
    }
    let host = parsed.host_str().ok_or("Invalid machine address")?;
    match parsed.scheme() {
        "https" => {}
        "http" if tailnet(host) => {}
        _ => return Err("This machine's address must use HTTPS or Tailscale".into()),
    }
    Ok(format!("{}/mobile", parsed.origin().ascii_serialization()))
}

/// A tailnet's MagicDNS name or address, or this device itself.
fn tailnet(host: &str) -> bool {
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if host.ends_with(".ts.net") || host == "localhost" {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            let [a, b, ..] = ip.octets();
            ip.is_loopback() || (a == 100 && (64..=127).contains(&b))
        }
        Ok(IpAddr::V6(ip)) => {
            let segments = ip.segments();
            ip.is_loopback() || segments[..3] == [0xfd7a, 0x115c, 0xa1e0]
        }
        Err(_) => false,
    }
}

/// One request, answered as the desktop's link answers: the result, or the
/// error the host gave. Blocking; run on a blocking thread.
fn post(link: &HostLink, request: &Value, wait: Duration) -> Result<Value, Failure> {
    let endpoint = endpoint(&link.url).map_err(Failure::Refused)?;
    let body = serde_json::to_vec(request).map_err(|e| Failure::Refused(e.to_string()))?;
    if body.len() > REQUEST_LIMIT {
        return Err(Failure::Refused(
            "Message exceeds the connection limit".into(),
        ));
    }
    let mut call = agent()
        .post(&endpoint)
        .timeout(wait)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json");
    if !link.token.is_empty() {
        call = call.set("Authorization", &format!("Bearer {}", link.token));
    }
    let response =
        match call.send_bytes(&body) {
            Ok(response) | Err(ureq::Error::Status(_, response)) => response,
            Err(ureq::Error::Transport(error)) => return Err(Failure::Link(match error.kind() {
                ureq::ErrorKind::Dns | ureq::ErrorKind::ConnectionFailed => {
                    "Cannot reach this machine. Check that Tailscale is connected on this phone."
                        .into()
                }
                ureq::ErrorKind::Io => "This machine stopped answering".into(),
                _ => format!("Cannot reach this machine: {error}"),
            })),
        };
    let status = response.status();
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(RESPONSE_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| Failure::Link(e.to_string()))?;
    if bytes.len() > RESPONSE_LIMIT {
        return Err(Failure::Refused(
            "Message exceeds the connection limit".into(),
        ));
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        // Not the host: a proxy page, say, from Serve forwarding elsewhere.
        Failure::Refused(format!(
            "This address answered as something other than MonoCode (HTTP {status})"
        ))
    })?;
    if value["ok"] == true {
        Ok(value["result"].clone())
    } else {
        Err(Failure::Refused(
            value["error"]
                .as_str()
                .unwrap_or("Machine request failed")
                .into(),
        ))
    }
}

async fn post_async(link: HostLink, request: Value, wait: Duration) -> Result<Value, Failure> {
    tokio::task::spawn_blocking(move || post(&link, &request, wait))
        .await
        .unwrap_or_else(|_| Err(Failure::Link("Machine request stopped".into())))
}

pub async fn exchange(link: &HostLink, request: Value) -> LinkResult<Value> {
    let wait = exchange_timeout(&request);
    // A request whose reply was lost is sent again under its ID, which the
    // host takes only once.
    match post_async(link.clone(), request.clone(), wait).await {
        Err(Failure::Link(_)) => Ok(post_async(link.clone(), request, wait).await?),
        other => Ok(other?),
    }
}

/// Opens a watch: the host keeps its place, and each poll brings the frames
/// since the last one. A poll whose reply was lost asks again for it.
pub async fn watch(link: &HostLink, request: Value) -> LinkResult<Watch> {
    let opened = post_async(link.clone(), request, Duration::from_secs(35)).await?;
    let watch_id = opened["watchId"]
        .as_str()
        .ok_or("This machine could not watch the conversation")?
        .to_string();
    let (sender, updates) = mpsc::unbounded_channel();
    let ready = Arc::new(Notify::new());
    let incoming = ready.clone();
    let ended = Arc::new(AtomicBool::new(false));
    let ending = ended.clone();
    let polling = link.clone();
    let id = watch_id.clone();
    let task = tokio::spawn(async move {
        let mut after = 0;
        let mut failures = 0;
        loop {
            let next = json!({
                "version": 1,
                "id": "watch",
                "method": "watch.next",
                "params": {"watchId": id, "after": after, "wait": WATCH_WAIT.as_millis() as u64},
            });
            match post_async(polling.clone(), next, WATCH_WAIT + Duration::from_secs(15)).await {
                Ok(value) => {
                    failures = 0;
                    after = value["seq"].as_u64().unwrap_or(after);
                    let frames = value["updates"].as_array().cloned().unwrap_or_default();
                    if frames.is_empty() {
                        continue;
                    }
                    for frame in frames {
                        if sender.send(Ok(frame)).is_err() {
                            return;
                        }
                    }
                    incoming.notify_waiters();
                }
                Err(Failure::Link(_)) if failures < WATCH_RETRIES => {
                    failures += 1;
                    tokio::time::sleep(Duration::from_millis(500 * u64::from(failures))).await;
                }
                Err(failure) => {
                    ending.store(true, Ordering::Relaxed);
                    let _ = sender.send(Err(failure.into()));
                    incoming.notify_waiters();
                    return;
                }
            }
        }
    });
    let closing = link.clone();
    let stop = move || {
        let request = json!({
            "version": 1,
            "id": "watch",
            "method": "watch.close",
            "params": {"watchId": watch_id},
        });
        let link = closing.clone();
        std::thread::spawn(move || {
            let _ = post(&link, &request, Duration::from_secs(5));
        });
    };
    Ok(Watch::new(
        WatchLink::Host(Box::new(stop)),
        updates,
        ready,
        task,
        ended,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        sync::Mutex,
    };

    #[test]
    fn only_encrypted_or_tailnet_addresses_are_used() {
        assert_eq!(
            endpoint("https://box.tailnet.ts.net/").unwrap(),
            "https://box.tailnet.ts.net/mobile"
        );
        assert_eq!(
            endpoint("http://box.tailnet.ts.net:3774").unwrap(),
            "http://box.tailnet.ts.net:3774/mobile"
        );
        assert!(endpoint("http://100.110.106.27:3774").is_ok());
        assert!(endpoint("http://[fd7a:115c:a1e0::1]:3774").is_ok());
        assert!(endpoint("http://127.0.0.1:3774").is_ok());
        assert!(endpoint("http://192.168.1.4:3774").is_err());
        assert!(endpoint("http://example.com").is_err());
        assert!(endpoint("https://user:secret@example.com").is_err());
        assert!(endpoint("ftp://box.tailnet.ts.net").is_err());
    }

    /// A stand-in host: answers each POST with the next reply, recording the
    /// requests and their credentials.
    fn host(replies: Vec<Value>) -> (String, Arc<Mutex<Vec<(String, Value)>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            let mut replies = replies.into_iter();
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut length = 0;
                let mut authorization = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    let line = line.trim_end();
                    if line.is_empty() {
                        break;
                    }
                    let lower = line.to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                    if lower.starts_with("authorization:") {
                        authorization = line["authorization:".len()..].trim().to_string();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                log.lock()
                    .unwrap()
                    .push((authorization, serde_json::from_slice(&body).unwrap()));
                let reply = replies.next().unwrap_or(json!({"ok":true,"result":null}));
                let text = reply.to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                    text.len()
                )
                .unwrap();
            }
        });
        (url, seen)
    }

    #[tokio::test]
    async fn exchanges_carry_the_credential_and_return_the_host_answer() {
        let (url, seen) = host(vec![
            json!({"ok":true,"result":{"projects":[]}}),
            json!({"ok":false,"error":"Monos live on your desktop"}),
        ]);
        let link = HostLink {
            url,
            token: "a".repeat(43),
        };
        let request = json!({"version":1,"id":"1","method":"workspace.list","params":{}});
        assert_eq!(
            exchange(&link, request).await.unwrap(),
            json!({"projects":[]})
        );
        let refused = exchange(&link, json!({"version":1,"id":"2","method":"mono.profile"})).await;
        assert_eq!(refused.unwrap_err(), "Monos live on your desktop");
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, format!("Bearer {}", "a".repeat(43)));
        assert_eq!(seen[0].1["method"], "workspace.list");
    }

    #[tokio::test]
    async fn a_watch_streams_frames_in_order_and_ends_on_the_host_refusal() {
        let (url, seen) = host(vec![
            json!({"ok":true,"result":{"watchId":"w1"}}),
            json!({"ok":true,"result":{"seq":1,"updates":[{"busy":true,"order":["t1"]}]}}),
            json!({"ok":true,"result":{"seq":1,"updates":[]}}),
            json!({"ok":true,"result":{"seq":2,"updates":[{"busy":false},{"approval":null}]}}),
            json!({"ok":false,"error":"Transcript window needs to reopen"}),
        ]);
        let link = HostLink {
            url,
            token: "t".repeat(43),
        };
        let watch = watch(
            &link,
            json!({"version":1,"id":"1","method":"conversation.watch","params":{"conversationId":"s"}}),
        )
        .await
        .unwrap();
        let mut frames = Vec::new();
        while frames.len() < 3 {
            frames.extend(watch.next(Duration::from_secs(5)).await.unwrap());
        }
        assert_eq!(frames[0]["order"], json!(["t1"]));
        assert_eq!(frames[1]["busy"], false);
        assert!(frames[2].get("approval").is_some());
        let ended = watch.next(Duration::from_secs(5)).await;
        assert_eq!(ended.unwrap_err(), "Transcript window needs to reopen");
        watch.close().await;
        let seen = seen.lock().unwrap();
        // Each poll names the frames it has, so a lost reply comes again.
        let afters: Vec<_> = seen[1..]
            .iter()
            .map(|(_, request)| request["params"]["after"].as_u64().unwrap())
            .collect();
        assert_eq!(afters, [0, 1, 1, 2]);
        assert!(seen
            .iter()
            .all(|(token, _)| token == &format!("Bearer {}", "t".repeat(43))));
    }

    #[tokio::test]
    async fn an_unreachable_machine_says_to_check_tailscale() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let link = HostLink {
            url,
            token: String::new(),
        };
        let error = exchange(
            &link,
            json!({"version":1,"id":"1","method":"workspace.list"}),
        )
        .await
        .unwrap_err();
        assert!(error.contains("Tailscale"), "{error}");
    }

    /// Against a running host: `monocode-host phone --url <its address>`
    /// prints the link to set in MONOCODE_E2E_PHONE_LINK. Pairs, lists the
    /// workspace, watches its newest session, reads the project's files, and
    /// leaves, revoking the credential it was given.
    #[tokio::test]
    #[ignore]
    async fn pairs_and_works_with_a_real_host() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let link = std::env::var("MONOCODE_E2E_PHONE_LINK").expect("MONOCODE_E2E_PHONE_LINK");
        let code = url::Url::parse(&link)
            .unwrap()
            .query_pairs()
            .find(|(key, _)| key == "i")
            .unwrap()
            .1
            .to_string();
        let invite: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(code).unwrap()).unwrap();
        assert_eq!(invite["kind"], "host");
        let mut link = HostLink {
            url: invite["url"].as_str().unwrap().into(),
            token: String::new(),
        };
        let request = |method: &str, params: Value| json!({"version": 1, "id": format!("e2e-{method}"), "method": method, "params": params});
        let enrolled = exchange(
            &link,
            request(
                "device.enroll",
                json!({"code": invite["code"], "name": "E2E phone"}),
            ),
        )
        .await
        .unwrap();
        assert_eq!(enrolled["environmentId"], invite["environmentId"]);
        link.token = enrolled["token"].as_str().unwrap().into();

        let workspace = exchange(&link, request("workspace.list", json!({})))
            .await
            .unwrap();
        let project = workspace["projects"][0]["id"].as_str().unwrap().to_string();
        assert_eq!(workspace["monos"], json!([]));
        let session = workspace["sessions"][0]["id"].as_str().unwrap().to_string();
        let watch = watch(
            &link,
            request(
                "conversation.watch",
                json!({"conversationId": session, "tail": 3, "incremental": true}),
            ),
        )
        .await
        .unwrap();
        let first = watch.next(Duration::from_secs(10)).await.unwrap();
        assert!(first[0]["order"].is_array(), "{first:?}");
        assert!(first[0].get("approval").is_some(), "{first:?}");
        watch.close().await;
        let read = exchange(
            &link,
            request("conversation.read", json!({"conversationId": session})),
        )
        .await
        .unwrap();
        assert_eq!(read["id"], session);
        let files = exchange(
            &link,
            request("project.files", json!({"projectId": project, "path": ""})),
        )
        .await
        .unwrap();
        assert!(files["entries"]
            .as_array()
            .is_some_and(|entries| !entries.is_empty()));

        exchange(&link, request("device.leave", json!({})))
            .await
            .unwrap();
        let refused = exchange(&link, request("workspace.list", json!({})))
            .await
            .unwrap_err();
        assert!(refused.contains("no longer paired"), "{refused}");
    }
}
