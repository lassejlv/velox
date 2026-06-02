import { caller } from "./circular-a.ts";
export function helper() { return 10; }
export function viaCaller() { return caller(); }
