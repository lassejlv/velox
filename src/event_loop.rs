use rusty_v8 as v8;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::thread;

type ResolverMap = HashMap<u64, v8::Global<v8::PromiseResolver>>;
type ResultCallback = Box<dyn FnOnce(&mut v8::HandleScope, v8::Local<v8::PromiseResolver>) + Send>;

thread_local! {
    static RESOLVERS: RefCell<ResolverMap> = RefCell::new(HashMap::new());
    static NEXT_ID: RefCell<u64> = RefCell::new(0);
}

pub struct EventLoop {
    receiver: Receiver<(u64, ResultCallback)>,
    sender: Sender<(u64, ResultCallback)>,
    active_count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl EventLoop {
    pub fn new() -> Self {
        let (sender, receiver) = channel();
        Self {
            receiver,
            sender,
            active_count: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }

    pub fn handle(&self) -> EventLoopHandle {
        EventLoopHandle {
            sender: self.sender.clone(),
            active_count: self.active_count.clone(),
        }
    }

    pub fn run(&self, scope: &mut v8::HandleScope) {
        use std::sync::atomic::Ordering;

        loop {
            match self.receiver.try_recv() {
                Ok((id, callback)) => {
                    RESOLVERS.with(|resolvers| {
                        if let Some(resolver_global) = resolvers.borrow_mut().remove(&id) {
                            let resolver = v8::Local::new(scope, resolver_global);
                            callback(scope, resolver);
                        }
                    });
                    self.active_count.fetch_sub(1, Ordering::SeqCst);
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {
                    if self.active_count.load(Ordering::SeqCst) == 0 {
                        break;
                    }
                    thread::sleep(std::time::Duration::from_millis(1));
                }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
            }
        }
    }
}

#[derive(Clone)]
pub struct EventLoopHandle {
    sender: Sender<(u64, ResultCallback)>,
    active_count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl EventLoopHandle {
    pub fn register_resolver(
        &self,
        scope: &mut v8::HandleScope,
        resolver: v8::Local<v8::PromiseResolver>,
    ) -> u64 {
        let id = NEXT_ID.with(|n| {
            let mut n = n.borrow_mut();
            let id = *n;
            *n += 1;
            id
        });

        let global = v8::Global::new(scope, resolver);
        RESOLVERS.with(|resolvers| {
            resolvers.borrow_mut().insert(id, global);
        });

        self.active_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        id
    }

    pub fn spawn<F>(&self, id: u64, work: F)
    where
        F: FnOnce() -> ResultCallback + Send + 'static,
    {
        let sender = self.sender.clone();

        thread::spawn(move || {
            let callback = work();
            let _ = sender.send((id, callback));
        });
    }
}
