// A class export and a couple of named function exports.
export class Greeter {
  constructor(private name: string) {}

  greet(): string {
    return `Hello, ${this.name}!`;
  }
}

export function shout(text: string): string {
  return text.toUpperCase() + "!";
}

// Re-export everything from math under this module too, to exercise
// `export * from './math'`.
export * from "./math";
