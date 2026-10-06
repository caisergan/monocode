//! `monocode-preview://` serves local HTML files to the in-app browser.
//!
//! The URL keeps the real path as path segments
//! (`monocode-preview://localhost/Users/me/site/index.html`) so a page's
//! relative `./style.css` resolves next to it, the way it would from
//! `file://`. Only files under a root the frontend registered — a project
//! directory it is previewing — are served.
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

/// `origin` is the request's `Origin` header. Preview pages send `null`, and
/// navigations and plain subresources send none. Anything else is a site in a
/// browser tab, which keeps its own origin and would otherwise read project
/// files through the `*` CORS grant.
fn respond(roots: &PreviewRoots, url_path: &str, origin: Option<&str>) -> Response<Vec<u8>> {
    let served = match origin {
        Some(origin) if origin != "null" => Err(StatusCode::FORBIDDEN),
        _ => resolve(roots, url_path).and_then(|path| read(&path)),
    };
    match served {
        Ok((bytes, mime)) => response(StatusCode::OK, mime, bytes),
        Err(status) => response(
            status,
            "text/plain; charset=utf-8",
            status
                .canonical_reason()
                .unwrap_or("Error")
                .as_bytes()
                .to_vec(),
        ),
    }
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
    fn reports_missing_files() {
        let (base, roots) = fixture();
        let response = respond(&roots, &url(&base.join("site/missing.html")), None);
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
