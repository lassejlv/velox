use crate::colors;
use std::io::IsTerminal;
use std::io::Write;
use std::time::Instant;

pub(super) struct InstallReporter {
    start: Instant,
    installed_count: usize,
    lock_reused_count: usize,
    cache_reused_count: usize,
    resolved_count: usize,
    metadata_cache_hits: usize,
    tarball_cache_hits: usize,
    verbose: bool,
    progress_enabled: bool,
    total_targets: usize,
    completed_targets: usize,
}

impl InstallReporter {
    pub(super) fn new() -> Self {
        Self {
            start: Instant::now(),
            installed_count: 0,
            lock_reused_count: 0,
            cache_reused_count: 0,
            resolved_count: 0,
            metadata_cache_hits: 0,
            tarball_cache_hits: 0,
            verbose: std::env::var("VELOX_PKG_VERBOSE")
                .ok()
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false),
            progress_enabled: std::io::stderr().is_terminal(),
            total_targets: 0,
            completed_targets: 0,
        }
    }

    fn prefix(depth: usize) -> String {
        format!("{}{}", "  ".repeat(depth), colors::DIM)
    }

    pub(super) fn resolving(&self, package_name: &str, requested: Option<&str>, depth: usize) {
        if !self.verbose && depth > 0 {
            return;
        }
        self.clear_progress_line();
        let requested = requested.unwrap_or("latest");
        eprintln!(
            "{}{}resolve{} {} ({}){}",
            Self::prefix(depth),
            colors::CYAN,
            colors::RESET,
            package_name,
            requested,
            colors::RESET
        );
    }

    pub(super) fn reused_lock(&mut self, package_name: &str, version: &str, depth: usize) {
        self.lock_reused_count += 1;
        if !self.verbose && depth > 0 {
            return;
        }
        self.clear_progress_line();
        eprintln!(
            "{}{}lock{} {}@{}{}",
            Self::prefix(depth),
            colors::YELLOW,
            colors::RESET,
            package_name,
            version,
            colors::RESET
        );
    }

    pub(super) fn reused_session(&self, package_name: &str, version: &str, depth: usize) {
        if !self.verbose && depth > 0 {
            return;
        }
        self.clear_progress_line();
        eprintln!(
            "{}{}cache{} {}@{}{}",
            Self::prefix(depth),
            colors::CYAN,
            colors::RESET,
            package_name,
            version,
            colors::RESET
        );
    }

    pub(super) fn installed(
        &mut self,
        package_name: &str,
        version: &str,
        dep_count: usize,
        depth: usize,
    ) {
        self.installed_count += 1;
        if !self.verbose && depth > 0 {
            return;
        }
        self.clear_progress_line();
        eprintln!(
            "{}{}installed{} {}@{} {}(deps: {}){}",
            Self::prefix(depth),
            colors::GREEN,
            colors::RESET,
            package_name,
            version,
            colors::DIM,
            dep_count,
            colors::RESET
        );
    }

    pub(super) fn summary(&self) {
        if self.progress_enabled {
            self.clear_progress_line();
        }
        eprintln!(
            "{}Done:{} {} package(s) installed, {} lock reuse(s), {} cache reuse(s), {} resolved, {} metadata cache hit(s), {} tarball cache hit(s) in {:.2}s",
            colors::BOLD,
            colors::RESET,
            self.installed_count,
            self.lock_reused_count,
            self.cache_reused_count,
            self.resolved_count,
            self.metadata_cache_hits,
            self.tarball_cache_hits,
            self.start.elapsed().as_secs_f64()
        );
        if !self.verbose {
            eprintln!(
                "{}Tip:{} set VELOX_PKG_VERBOSE=1 for full dependency tree logs",
                colors::DIM,
                colors::RESET
            );
        }
    }

    pub(super) fn count_resolve(&mut self) {
        self.resolved_count += 1;
    }

    pub(super) fn count_cache_reuse(&mut self) {
        self.cache_reused_count += 1;
    }

    pub(super) fn count_metadata_cache_hit(&mut self) {
        self.metadata_cache_hits += 1;
    }

    pub(super) fn count_tarball_cache_hit(&mut self) {
        self.tarball_cache_hits += 1;
    }

    pub(super) fn register_target(&mut self) {
        self.total_targets += 1;
        self.render_progress();
    }

    pub(super) fn complete_target(&mut self) {
        self.completed_targets += 1;
        self.render_progress();
    }

    fn render_progress(&self) {
        if !self.progress_enabled || self.total_targets == 0 {
            return;
        }
        let width = 24usize;
        let ratio = self.completed_targets as f64 / self.total_targets as f64;
        let filled = (ratio * width as f64).round() as usize;
        let bar = format!(
            "{}{}",
            "#".repeat(filled.min(width)),
            "-".repeat(width.saturating_sub(filled.min(width)))
        );
        eprint!(
            "\r{}progress{} [{}] {}/{}",
            colors::DIM,
            colors::RESET,
            bar,
            self.completed_targets,
            self.total_targets
        );
        let _ = std::io::stderr().flush();
    }

    fn clear_progress_line(&self) {
        if !self.progress_enabled || self.total_targets == 0 {
            return;
        }
        eprint!("\r\x1b[2K");
        let _ = std::io::stderr().flush();
    }

    pub(super) fn tracked(&self, name: &str, spec: &str) {
        self.clear_progress_line();
        eprintln!(
            "{}tracked{} {} -> {}",
            colors::CYAN,
            colors::RESET,
            name,
            spec
        );
    }
}
