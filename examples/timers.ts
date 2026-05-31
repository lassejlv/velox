// Run with: cargo run -- examples/timers.ts
//
// Demonstrates the event loop: setTimeout, setInterval/clearInterval, and
// async/await composing on top of timers via Promises.

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function countdown(from: number): Promise<void> {
  for (let n = from; n > 0; n--) {
    console.log(`T-minus ${n}`);
    await delay(150);
  }
  console.log("liftoff! 🚀");
}

let beeps = 0;
const beeper = setInterval(() => {
  beeps++;
  console.info(`beep ${beeps}`);
  if (beeps === 3) clearInterval(beeper);
}, 100);

countdown(3);
