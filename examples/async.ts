// Run with: cargo run -- examples/async.ts
//
// Top-level await — no wrapping `async function` needed.

interface Todo {
  id: number;
  title: string;
  completed: boolean;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

console.log("fetching a todo...");

const res = await fetch("https://jsonplaceholder.typicode.com/todos/1");
console.log("status:", res.status, res.statusText);
console.log("content-type:", res.headers.get("content-type"));

const todo: Todo = await res.json();
console.log("todo:", todo);

await delay(100);
console.log("...and 100ms later, done.");
