// utils.ts - A module with various exports

// Named exports
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export const PI = 3.14159;

export const VERSION = "1.0.0";

// Default export
const utils = {
  add,
  subtract,
  PI,
  VERSION,
};

export default utils;
