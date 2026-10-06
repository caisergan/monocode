//! `monocode-preview://` serves local HTML files to the in-app browser, and
//! `monocode-remote://` serves files of projects on a connected machine.
//!
//! The URL keeps the real path as path segments
//! (`monocode-preview://localhost/Users/me/site/index.html`) so a page's
//! relative `./style.css` resolves next to it, the way it would from
//! `file://`. Only files under a root the frontend registered — a project
//! directory it is previewing — are served.
//!
//! A remote URL carries the `remote://` path's environment and host path
//! (`monocode-remote://localhost/<environment>/home/me/site/index.html`). Each
//! request, page and assets alike, is read from that machine's host, which
//! only serves files inside its registered projects.
//!
//! The app treats a registered custom scheme as a local origin, so the IPC
//! ACL does not protect against a previewed page. What does: the invoke key is
//! injected into the main frame only, and every response carries a CSP
//! `sandbox` without `allow-same-origin`. The page gets an opaque origin, whose
//! `Origin: null` the IPC handler rejects, even when it was reached by a site
//! navigating its own (same-origin) frame here rather than through the app's
//! sandboxed iframe.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, State, UriSchemeContext, UriSchemeResponder};

use crate::fs::expand_home;

pub const SCHEME: &str = "monocode-preview";
pub const REMOTE_SCHEME: &str = "monocode-remote";

/// Matches the frontend's iframe sandbox for preview pages.
const SANDBOX: &str = "sandbox allow-scripts allow-forms allow-modals";

/// Project roots the frontend is previewing, canonicalized.
#[derive(Default)]
pub struct PreviewRoots(Mutex<Vec<PathBuf>>);

impl PreviewRoots {
    fn allow(&self, root: PathBuf) {
        let mut roots = self.0.lock().unwrap();
        if !roots.contains(&root) {
            roots.push(root);
        }
    }

    fn contains(&self, path: &Path) -> bool {
        self.0
            .lock()
            .unwrap()
            .iter()
            .any(|root| path.starts_with(root))
    }
}

#[tauri::command]
pub fn browser_preview_allow_root(
    roots: State<'_, PreviewRoots>,
    root: String,
) -> Result<(), String> {
    let root = expand_home(&root)
        .canonicalize()
        .map_err(|error| format!("Cannot preview {root}: {error}"))?;
    if !root.is_dir() {
        return Err("Preview root must be a directory".into());
    }
    // A page may read any file under its root, so never hand it a whole home
    // directory or drive.
    let home = crate::dirs_home().and_then(|home| PathBuf::from(home).canonicalize().ok());
    if root.parent().is_none() || home.as_deref() == Some(root.as_path()) {
        return Err("Open a project folder to preview its pages.".into());
    }
    roots.allow(root);
    Ok(())
}

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app: AppHandle<R> = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let roots = app.state::<PreviewRoots>();
        let origin = request
            .headers()
            .get(header::ORIGIN)
            .map(|value| value.to_str().unwrap_or_default());
        responder.respond(respond(&roots, request.uri().path(), origin));
    });
}

pub fn handle_remote(
    ctx: UriSchemeContext<'_, tauri::Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let origin = request
            .headers()
            .get(header::ORIGIN)
            .map(|value| value.to_str().unwrap_or_default());
        responder.respond(respond_remote(
            request.uri().path(),
            origin,
            |environment, path| crate::remote::read_host_file(&app, environment, path),
        ));
    });
}

/// `origin` is the request's `Origin` header. Preview pages send `null`, and
/// navigations and plain subresources send none. Anything else is a site in a
/// browser tab, which keeps its own origin and would otherwise read project
/// files through the `*` CORS grant.
fn cross_origin(origin: Option<&str>) -> bool {
    origin.is_some_and(|origin| origin != "null")
}

fn respond(roots: &PreviewRoots, url_path: &str, origin: Option<&str>) -> Response<Vec<u8>> {
    let served = if cross_origin(origin) {
        Err(StatusCode::FORBIDDEN)
    } else {
        resolve(roots, url_path).and_then(|path| read(&path))
    };
    match served {
        Ok((bytes, mime)) => response(StatusCode::OK, mime, bytes),
        Err(status) => error_response(status, None),
    }
}

fn respond_remote(
    url_path: &str,
    origin: Option<&str>,
    read_host: impl FnOnce(&str, &str) -> Result<Vec<u8>, String>,
) -> Response<Vec<u8>> {
    if cross_origin(origin) {
        return error_response(StatusCode::FORBIDDEN, None);
    }
    let Some((environment, host_path)) = parse_remote_url_path(url_path) else {
        return error_response(StatusCode::BAD_REQUEST, None);
    };
    match read_host(&environment, &host_path) {
        Ok(bytes) => response(StatusCode::OK, mime_for(Path::new(&host_path)), bytes),
        // The host's reason ("not connected", "too large", outside a project)
        // is what the page area shows when the document itself fails.
        Err(message) => error_response(StatusCode::BAD_GATEWAY, Some(&message)),
    }
}

/// `/<environment>/home/me/a%20b.html` → (`<environment>`, `/home/me/a b.html`).
/// Windows hosts keep their drive letter: `/<environment>/C:/site/index.html`.
fn parse_remote_url_path(url_path: &str) -> Option<(String, String)> {
    let (environment, rest) = url_path.strip_prefix('/')?.split_once('/')?;
    let environment = decode_segment(environment)?;
    let segments = rest
        .split('/')
        .map(decode_segment)
        .collect::<Option<Vec<_>>>()?;
    if environment.is_empty() || segments.iter().any(|segment| segment.is_empty()) {
        return None;
    }
    let joined = segments.join("/");
    let drive = joined.len() >= 2
        && joined.as_bytes()[0].is_ascii_alphabetic()
        && joined.as_bytes()[1] == b':'
        && joined.as_bytes().get(2).is_none_or(|byte| *byte == b'/');
    Some((
        environment,
        if drive { joined } else { format!("/{joined}") },
    ))
}

/// One decoded path segment; one that decodes into a separator or `..` is refused.
fn decode_segment(segment: &str) -> Option<String> {
    let decoded = percent_encoding::percent_decode_str(segment)
        .decode_utf8()
        .ok()?
        .into_owned();
    if decoded.contains(['/', '\\', '\0']) || decoded == ".." || decoded == "." {
        return None;
    }
    Some(decoded)
}

fn error_response(status: StatusCode, message: Option<&str>) -> Response<Vec<u8>> {
    let body = message
        .or(status.canonical_reason())
        .unwrap_or("Error")
        .as_bytes()
        .to_vec();
    response(status, "text/plain; charset=utf-8", body)
}

fn response(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_SECURITY_POLICY, SANDBOX)
        // The sandboxed frame has an opaque origin, so module scripts and the
        // page's own fetch() of sibling files are CORS requests.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .unwrap()
}

/// Map a request path to a file inside an allowed root.
fn resolve(roots: &PreviewRoots, url_path: &str) -> Result<PathBuf, StatusCode> {
    let path = url_path_to_file(url_path).ok_or(StatusCode::BAD_REQUEST)?;
    // Canonicalizing first resolves `..` and symlinks, so the prefix check
    // sees where the file really is.
    let mut path = path.canonicalize().map_err(|_| StatusCode::NOT_FOUND)?;
    if !roots.contains(&path) {
        return Err(StatusCode::FORBIDDEN);
    }
    if path.is_dir() {
        path = path
            .join("index.html")
            .canonicalize()
            .map_err(|_| StatusCode::NOT_FOUND)?;
        if !roots.contains(&path) {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    Ok(path)
}

/// `/Users/me/a%20b.html` → `/Users/me/a b.html`; `/C:/x` → `C:\x` on Windows.
fn url_path_to_file(url_path: &str) -> Option<PathBuf> {
    url::Url::parse(&format!("file://{url_path}"))
        .ok()?
        .to_file_path()
        .ok()
}

fn read(path: &Path) -> Result<(Vec<u8>, &'static str), StatusCode> {
    let bytes = std::fs::read(path).map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((bytes, mime_for(path)))
}

fn mime_for(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, PreviewRoots) {
        let base = std::env::temp_dir().join(format!("monocode-preview-{}", uuid::Uuid::new_v4()));
        let site = base.join("site");
        std::fs::create_dir_all(site.join("assets")).unwrap();
        std::fs::write(site.join("index.html"), "<p>hi</p>").unwrap();
        std::fs::write(site.join("assets/a b.css"), "p{}").unwrap();
        std::fs::write(base.join("secret.txt"), "nope").unwrap();
        let base = base.canonicalize().unwrap();
        let roots = PreviewRoots::default();
        roots.allow(base.join("site"));
        (base, roots)
    }

    fn url(path: &Path) -> String {
        url::Url::from_file_path(path).unwrap().path().to_owned()
    }

    #[test]
    fn serves_files_inside_a_root_with_their_mime() {
        let (base, roots) = fixture();
        let response = respond(&roots, &url(&base.join("site/assets/a b.css")), None);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"p{}");
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/css; charset=utf-8"
        );
        assert_eq!(
            response.headers()[header::CONTENT_SECURITY_POLICY],
            "sandbox allow-scripts allow-forms allow-modals"
        );
    }

    #[test]
    fn serves_index_html_for_a_directory() {
        let (base, roots) = fixture();
        let response = respond(&roots, &url(&base.join("site")), None);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"<p>hi</p>");
    }

    #[test]
    fn refuses_files_outside_every_root() {
        let (base, roots) = fixture();
        let direct = respond(&roots, &url(&base.join("secret.txt")), None);
        assert_eq!(direct.status(), StatusCode::FORBIDDEN);
        let dotdot = format!("{}/../secret.txt", url(&base.join("site")));
        assert_eq!(
            respond(&roots, &dotdot, None).status(),
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn refuses_symlinks_that_leave_the_root() {
        let (base, roots) = fixture();
        std::os::unix::fs::symlink(base.join("secret.txt"), base.join("site/link.txt")).unwrap();
        let response = respond(&roots, &url(&base.join("site/link.txt")), None);
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn refuses_cross_origin_reads_from_sites() {
        let (base, roots) = fixture();
        let page = url(&base.join("site/index.html"));
        let site = respond(&roots, &page, Some("https://evil.example"));
        assert_eq!(site.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            respond(&roots, &page, Some("null")).status(),
            StatusCode::OK
        );
    }

    #[test]
    fn reads_remote_files_from_the_host_that_owns_them() {
        let response = respond_remote("/env-1/home/me/my%20site/style.css", None, |env, path| {
            assert_eq!((env, path), ("env-1", "/home/me/my site/style.css"));
            Ok(b"p{}".to_vec())
        });
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"p{}");
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/css; charset=utf-8"
        );
        assert_eq!(
            response.headers()[header::CONTENT_SECURITY_POLICY],
            "sandbox allow-scripts allow-forms allow-modals"
        );
    }

    #[test]
    fn keeps_a_windows_host_drive_letter() {
        assert_eq!(
            parse_remote_url_path("/env-1/C:/site/index.html"),
            Some(("env-1".into(), "C:/site/index.html".into()))
        );
    }

    #[test]
    fn refuses_malformed_or_cross_origin_remote_requests() {
        let unreachable = |_: &str, _: &str| -> Result<Vec<u8>, String> { panic!("read") };
        for path in [
            "/env-1",
            "/env-1/",
            "/env-1/a/../b",
            "/env-1/a%2Fb",
            "/env-1/a//b",
        ] {
            let response = respond_remote(path, None, unreachable);
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{path}");
        }
        let site = respond_remote("/env-1/a.html", Some("https://evil.example"), unreachable);
        assert_eq!(site.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn shows_why_the_host_could_not_serve_a_file() {
        let response = respond_remote("/env-1/a.html", Some("null"), |_, _| {
            Err("This project’s machine isn’t connected on this computer.".into())
        });
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            response.body(),
            "This project’s machine isn’t connected on this computer.".as_bytes()
        );
    }

    #[test]
    fn reports_missing_files() {
        let (base, roots) = fixture();
        let response = respond(&roots, &url(&base.join("site/missing.html")), None);
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
