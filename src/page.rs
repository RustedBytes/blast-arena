//! The game page as served, plus `robots.txt` and `sitemap.xml`.
//!
//! Link previews (Open Graph, X cards) and canonical links need absolute
//! URLs, so `index.html` writes `{{ORIGIN}}` where the site's address goes
//! and the server fills it in: from `--public-url` when set, otherwise from
//! the request (`X-Forwarded-Proto` / `X-Forwarded-Host` from a proxy such as
//! Caddy, else `Host`).

use axum::http::{HeaderMap, header};

/// Placeholder for the site's origin in `index.html`.
pub const ORIGIN: &str = "{{ORIGIN}}";

/// Checks a configured public URL: `http(s)://host[:port][/path]`, nothing
/// that would need escaping in HTML, XML or JSON. Returns it without a
/// trailing slash.
///
/// # Errors
/// A message saying what's wrong with it.
pub fn public_url(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/');
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| format!("public URL {url:?} must start with http:// or https://"))?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    if !valid_host(host) || !path.chars().all(|c| c.is_ascii_alphanumeric() || "-._~/".contains(c)) {
        return Err(format!("public URL {url:?} isn't a plain http(s) address"));
    }
    Ok(url.to_owned())
}

/// Host names and `host:port`, IPv6 in brackets included.
fn valid_host(host: &str) -> bool {
    !host.is_empty() && host.len() <= 255 && host.chars().all(|c| c.is_ascii_alphanumeric() || "-.:[]".contains(c))
}

/// The site's origin (`scheme://host`) for this request.
#[must_use]
pub fn origin(headers: &HeaderMap, public_url: Option<&str>) -> String {
    if let Some(url) = public_url {
        return url.to_owned();
    }
    let first = |name: &str| {
        headers.get(name).and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()).map(str::trim).filter(|v| !v.is_empty())
    };
    let scheme = match first("x-forwarded-proto") {
        Some(p) if p.eq_ignore_ascii_case("https") => "https",
        _ => "http",
    };
    let host = first("x-forwarded-host")
        .or_else(|| headers.get(header::HOST).and_then(|v| v.to_str().ok()))
        .filter(|h| valid_host(h))
        .unwrap_or("localhost");
    format!("{scheme}://{host}")
}

/// `index.html` with the origin filled in.
#[must_use]
pub fn render(html: &str, origin: &str) -> String {
    html.replace(ORIGIN, origin)
}

/// Crawlers may index the game page; the API, metrics and the internal
/// pages are off limits.
#[must_use]
pub fn robots(origin: &str) -> String {
    format!(
        "User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /ws\nDisallow: /metrics\nDisallow: /dashboard.html\nDisallow: /tiles.html\n\nSitemap: {origin}/sitemap.xml\n"
    )
}

/// The one page worth listing.
#[must_use]
pub fn sitemap(origin: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n  <url><loc>{origin}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn origin_from_config_proxy_or_host() {
        let h = headers(&[("host", "game:3000"), ("x-forwarded-proto", "https"), ("x-forwarded-host", "play.example.com")]);
        assert_eq!(origin(&h, Some("https://blast.example")), "https://blast.example");
        assert_eq!(origin(&h, None), "https://play.example.com");
        assert_eq!(origin(&headers(&[("host", "localhost:3000")]), None), "http://localhost:3000");
        assert_eq!(origin(&HeaderMap::new(), None), "http://localhost");
        // Anything that could break out of an attribute is ignored.
        assert_eq!(origin(&headers(&[("host", "evil\"><script>")]), None), "http://localhost");
        assert_eq!(origin(&headers(&[("host", "a.com"), ("x-forwarded-proto", "javascript")]), None), "http://a.com");
    }

    #[test]
    fn public_url_is_checked() {
        assert_eq!(public_url("https://blastarena.fun/").unwrap(), "https://blastarena.fun");
        assert_eq!(public_url("http://localhost:3000/game").unwrap(), "http://localhost:3000/game");
        assert!(public_url("blastarena.fun").is_err());
        assert!(public_url("https://a.com/\"x").is_err());
        assert!(public_url("https://").is_err());
    }

    #[test]
    fn fills_in_the_page_robots_and_sitemap() {
        let page = render("<link rel=\"canonical\" href=\"{{ORIGIN}}/\"><meta content=\"{{ORIGIN}}/og-image.jpg\">", "https://x.io");
        assert_eq!(page, "<link rel=\"canonical\" href=\"https://x.io/\"><meta content=\"https://x.io/og-image.jpg\">");
        assert!(robots("https://x.io").contains("Sitemap: https://x.io/sitemap.xml"));
        assert!(sitemap("https://x.io").contains("<loc>https://x.io/</loc>"));
    }

    #[test]
    fn the_real_page_uses_the_placeholder() {
        let html = include_str!("../static/index.html");
        for tag in ["og:image\" content=\"{{ORIGIN}}/og-image.jpg", "og:url\" content=\"{{ORIGIN}}/", "twitter:card", "rel=\"canonical\""] {
            assert!(html.contains(tag), "index.html has {tag}");
        }
    }
}
