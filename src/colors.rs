pub const RESET: &str = "\x1b[0m";
pub const BOLD: &str = "\x1b[1m";
pub const DIM: &str = "\x1b[2m";

pub const RED: &str = "\x1b[31m";
pub const YELLOW: &str = "\x1b[33m";
pub const CYAN: &str = "\x1b[36m";

pub fn error(msg: &str) -> String {
    format!("{BOLD}{RED}error{RESET}{BOLD}:{RESET} {msg}")
}

pub fn location(file: &str, line: usize, col: usize) -> String {
    format!("{CYAN}{file}{RESET}:{YELLOW}{line}{RESET}:{YELLOW}{col}{RESET}")
}
