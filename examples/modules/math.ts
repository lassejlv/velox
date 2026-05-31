// Named exports, both via declarations and an export list.
export const PI: number = 3.14159;

export function add(a: number, b: number): number {
  return a + b;
}

function multiply(a: number, b: number): number {
  return a * b;
}

const TAU: number = PI * 2;

export { multiply, TAU };

// A default export (an expression).
export default function square(n: number): number {
  return multiply(n, n);
}
