console.log("Starting interval test...");

let count = 0;

const intervalId = setInterval(() => {
  count++;
  console.log(`Interval fired: ${count}`);

  if (count >= 3) {
    clearInterval(intervalId);
    console.log("Interval cleared after 3 fires");
  }
}, 100);

setTimeout(() => {
  console.log("Timeout fired at 250ms");
}, 250);
