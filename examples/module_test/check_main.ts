// check_main.ts - Checks import.meta.main value

export function checkMain(): boolean {
  console.log(`  In check_main.ts: import.meta.main = ${import.meta.main}`);
  return import.meta.main;
}
