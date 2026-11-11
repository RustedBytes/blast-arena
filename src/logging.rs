//! Logging setup.
//!
//! The server logs through `tracing` (structured events and spans), and the
//! `log` crate is bridged into it, so messages from code or libraries using
//! `log::info!` and friends land in the same output with the same filter.
//!
//! The filter comes from `RUST_LOG` when set (e.g. `RUST_LOG=debug` or
//! `RUST_LOG=info,blast_arena::net=debug`), otherwise from
//! `--log-level`: a default level plus `target=level` pairs (no span or
//! field filters, which would need a regex engine). Output can be human-friendly (`pretty`, `compact`) or one
//! JSON object per line (`json`) for log collectors.

use std::fmt;

use clap::ValueEnum;
use tracing_subscriber::filter::Targets;
use tracing_subscriber::fmt::format::FmtSpan;
use tracing_subscriber::layer::SubscriberExt as _;

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum LogFormat {
    /// Multi-line, colourful, easiest to read.
    Pretty,
    /// One line per event.
    Compact,
    /// One JSON object per line.
    Json,
}

impl fmt::Display for LogFormat {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            LogFormat::Pretty => "pretty",
            LogFormat::Compact => "compact",
            LogFormat::Json => "json",
        })
    }
}

/// The filter to use: `RUST_LOG` if set and valid, otherwise `default`,
/// otherwise `info`.
#[must_use]
pub fn filter(default: &str) -> Targets {
    let parse = |s: &str| s.parse::<Targets>().ok();
    std::env::var("RUST_LOG")
        .ok()
        .and_then(|s| parse(&s))
        .or_else(|| parse(default))
        .unwrap_or_else(|| Targets::new().with_default(tracing::Level::INFO))
}

/// Installs the global subscriber and the `log` bridge. Call once at startup.
pub fn init(level: &str, format: LogFormat) {
    // Route `log` records into tracing.
    if let Err(e) = tracing_log::LogTracer::init() {
        eprintln!("log bridge already installed: {e}");
    }
    let targets = filter(level);
    let builder = tracing_subscriber::fmt().with_target(true);
    let result = match format {
        LogFormat::Pretty => tracing::subscriber::set_global_default(builder.pretty().finish().with(targets)),
        LogFormat::Compact => tracing::subscriber::set_global_default(builder.compact().finish().with(targets)),
        LogFormat::Json => tracing::subscriber::set_global_default(
            builder.json().flatten_event(true).with_current_span(true).with_span_list(false).with_span_events(FmtSpan::NONE).finish().with(targets),
        ),
    };
    if let Err(e) = result {
        eprintln!("logging already initialised: {e}");
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    use super::*;

    /// Collects formatted log output in memory.
    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl Write for Capture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn filters_parse_targets() {
        let f = filter("warn,blast_arena::net=debug");
        assert!(f.would_enable("blast_arena::net", &tracing::Level::DEBUG));
        assert!(!f.would_enable("blast_arena::game", &tracing::Level::INFO));
        assert!(f.would_enable("blast_arena::game", &tracing::Level::WARN));
    }

    #[test]
    fn log_crate_records_reach_tracing_output() {
        let _ = tracing_log::LogTracer::init();
        let out = Capture::default();
        let writer = out.clone();
        let subscriber = tracing_subscriber::fmt().json().with_writer(move || writer.clone()).finish().with(filter("info"));
        tracing::subscriber::with_default(subscriber, || {
            log::info!(target: "blast_test", "bridged message {}", 42);
            log::debug!(target: "blast_test", "filtered out");
            tracing::info!(player = 7, "native event");
        });
        let text = String::from_utf8(out.0.lock().unwrap().clone()).unwrap();
        let lines: Vec<serde_json::Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines.len(), 2, "debug is filtered at info: {text}");
        assert_eq!(lines[0]["fields"]["message"], "bridged message 42");
        assert_eq!(lines[0]["level"], "INFO");
        assert_eq!(lines[1]["fields"]["player"], 7);
    }
}
