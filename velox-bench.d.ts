/**
 * Type definitions for velox's built-in benchmark runner (`velox bench`).
 *
 * `bench`/`describe`/`group` and the `before*`/`after*` hooks are available as
 * globals in benchmark files (no import needed). They are also importable from
 * `"velox-bench"`. Reference this file from a benchmark file
 *
 *   /// <reference path="./velox-bench.d.ts" />
 *
 * or include it in your `tsconfig.json` (as `velox init` does).
 *
 * @platform macOS (darwin) only
 */

interface VeloxBenchOptions {
  /** Measured-window budget in milliseconds (default 500). */
  time?: number;
  /** Warmup budget in milliseconds before measuring (default 100). */
  warmup?: number;
}

// Returns anything — benchmark bodies often return a value to keep the work
// from being optimized away.
type VeloxBenchFn = () => unknown;

interface VeloxBench {
  (name: string, fn: VeloxBenchFn, opts?: VeloxBenchOptions): void;
  only(name: string, fn: VeloxBenchFn, opts?: VeloxBenchOptions): void;
  skip(name: string, fn: VeloxBenchFn, opts?: VeloxBenchOptions): void;
}

// Only the bench-unique globals are declared here; `describe` and the
// `before*`/`after*` hooks are shared with `velox-test.d.ts` (also shipped by
// `velox init`), so they aren't redeclared to avoid a duplicate-identifier
// clash when both definition files are in scope.
declare const bench: VeloxBench;
declare function group(name: string, fn: () => void): void;

declare module "velox-bench" {
  export const bench: VeloxBench;
  export function group(name: string, fn: () => void): void;
  export function describe(name: string, fn: () => void): void;
  export function beforeAll(fn: () => void | Promise<unknown>): void;
  export function afterAll(fn: () => void | Promise<unknown>): void;
  export function beforeEach(fn: () => void | Promise<unknown>): void;
  export function afterEach(fn: () => void | Promise<unknown>): void;
}
