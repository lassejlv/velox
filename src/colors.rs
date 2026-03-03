pub const RESET: &str = "\x1b[0m";
pub const BOLD: &str = "\x1b[1m";
pub const DIM: &str = "\x1b[2m";

pub const RED: &str = "\x1b[31m";
pub const GREEN: &str = "\x1b[32m";
pub const YELLOW: &str = "\x1b[33m";
pub const CYAN: &str = "\x1b[36m";

pub fn error(msg: &str) -> String {
    format!("{BOLD}{RED}error{RESET}{BOLD}:{RESET} {msg}")
}

pub fn location(file: &str, line: usize, col: usize) -> String {
    format!("{CYAN}{file}{RESET}:{YELLOW}{line}{RESET}:{YELLOW}{col}{RESET}")
}

pub fn green(msg: &str) -> String {
    format!("{GREEN}{msg}{RESET}")
}

pub fn yellow(msg: &str) -> String {
    format!("{YELLOW}{msg}{RESET}")
}
