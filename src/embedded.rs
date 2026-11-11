//! The browser client compiled into the binary (release builds), so the
//! server is a single self-contained file. `build.rs` generates the table
//! from `static/`; `--static-dir` still serves a directory instead.

use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

include!(concat!(env!("OUT_DIR"), "/embedded_static.rs"));

/// Content type for a file name, by extension.
fn content_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map_or("", |(_, ext)| ext) {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webmanifest" => "application/manifest+json",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// The embedded file for a URL path; a directory path means its `index.html`.
fn lookup(path: &str) -> Option<(&'static str, &'static [u8], &'static str)> {
    let path = path.trim_start_matches('/');
    let find = |p: &str| FILES.binary_search_by(|e| e.0.cmp(p)).ok().map(|i| FILES[i]);
    if path.is_empty() || path.ends_with('/') {
        return find(&format!("{path}index.html"));
    }
    find(path)
}

/// Fallback handler serving the embedded client. Browsers revalidate with
/// the `ETag` on each load (`no-cache`), so a new build is picked up at once
/// while unchanged files cost a 304.
pub async fn serve(uri: Uri, headers: HeaderMap) -> Response {
    let Some((path, body, etag)) = lookup(uri.path()) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    let tag = HeaderValue::from_static(etag);
    let cache = (header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    if headers.get(header::IF_NONE_MATCH).is_some_and(|v| v.as_bytes().split(|&b| b == b',').any(|t| t.trim_ascii() == etag.as_bytes())) {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, tag), cache]).into_response();
    }
    let ty = HeaderValue::from_static(content_type(path));
    ([(header::CONTENT_TYPE, ty), (header::ETAG, tag), cache], body).into_response()
}

/// An embedded file's contents by its path under `static/`.
#[must_use]
pub fn file(path: &str) -> Option<&'static [u8]> {
    lookup(path).map(|(_, body, _)| body)
}

/// How many files are embedded (for the startup log).
#[must_use]
pub fn count() -> usize {
    FILES.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_sorted_and_has_the_client() {
        assert!(FILES.windows(2).all(|w| w[0].0 < w[1].0), "binary search needs a sorted table");
        for p in ["index.html", "js/main.js", "style.css", "assets/pu_nuke.svg", "favicon.ico", "favicon.svg"] {
            assert!(FILES.iter().any(|e| e.0 == p), "{p} embedded");
        }
        assert!(FILES.iter().all(|e| !e.0.starts_with('.') && !e.0.contains("/.")), "no hidden files");
    }

    #[tokio::test]
    async fn serves_files_types_and_revalidation() {
        let res = serve(Uri::from_static("/"), HeaderMap::new()).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "text/html; charset=utf-8");
        let etag = res.headers()[header::ETAG].clone();

        let res = serve(Uri::from_static("/js/main.js?v=2"), HeaderMap::new()).await;
        assert_eq!(res.headers()[header::CONTENT_TYPE], "text/javascript; charset=utf-8");

        let mut h = HeaderMap::new();
        h.insert(header::IF_NONE_MATCH, etag);
        let res = serve(Uri::from_static("/index.html"), h).await;
        assert_eq!(res.status(), StatusCode::NOT_MODIFIED);

        // Browsers ask for /favicon.ico on their own, whatever the page links.
        let res = serve(Uri::from_static("/favicon.ico"), HeaderMap::new()).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "image/x-icon");

        let res = serve(Uri::from_static("/nope.js"), HeaderMap::new()).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        let res = serve(Uri::from_static("/../Cargo.toml"), HeaderMap::new()).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }
}
