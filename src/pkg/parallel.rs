//! A tiny bounded work-stealing `par_map` built on scoped threads — no async
//! runtime, no external crate. Used to fetch registry metadata and download
//! tarballs concurrently (both are network-bound).

use std::collections::VecDeque;
use std::sync::Mutex;

/// Apply `f` to every item across up to `workers` threads, preserving input
/// order in the returned vec. `f` must be `Sync` (shared across threads).
pub fn par_map<T, R, F>(items: Vec<T>, workers: usize, f: F) -> Vec<R>
where
    T: Send,
    R: Send,
    F: Fn(T) -> R + Sync,
{
    let n = items.len();
    if n == 0 {
        return Vec::new();
    }
    let queue: Mutex<VecDeque<(usize, T)>> =
        Mutex::new(items.into_iter().enumerate().collect());
    let results: Mutex<Vec<(usize, R)>> = Mutex::new(Vec::with_capacity(n));
    let threads = workers.clamp(1, n);

    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let next = { queue.lock().unwrap().pop_front() };
                let Some((idx, item)) = next else { break };
                let out = f(item);
                results.lock().unwrap().push((idx, out));
            });
        }
    });

    let mut collected = results.into_inner().unwrap();
    collected.sort_by_key(|(i, _)| *i);
    collected.into_iter().map(|(_, r)| r).collect()
}
