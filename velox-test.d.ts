/**
 * Type definitions for velox's built-in test runner (`velox test`).
 *
 * `describe`/`it`/`test`/`expect`/`vi` and the `before*`/`after*` hooks are
 * available as globals in test files (no import needed). They are also
 * importable from `"velox-test"`. Reference this file from a test file
 *
 *   /// <reference path="./velox-test.d.ts" />
 *
 * or include it in your `tsconfig.json` (as `velox init` does).
 *
 * @platform macOS (darwin) only
 */

interface VeloxAsymmetricMatcher {
  readonly __velox_asymmetric: true;
}

interface VeloxMatchers<T = unknown> {
  toBe(expected: T): void;
  toEqual(expected: unknown): void;
  toStrictEqual(expected: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeNaN(): void;
  toContain(item: unknown): void;
  toContainEqual(item: unknown): void;
  toHaveLength(length: number): void;
  toHaveProperty(path: string | string[], value?: unknown): void;
  toBeGreaterThan(n: number | bigint): void;
  toBeGreaterThanOrEqual(n: number | bigint): void;
  toBeLessThan(n: number | bigint): void;
  toBeLessThanOrEqual(n: number | bigint): void;
  toBeCloseTo(n: number, numDigits?: number): void;
  toMatch(pattern: string | RegExp): void;
  toMatchObject(object: object): void;
  toThrow(expected?: string | RegExp | Error | (new (...args: any[]) => any)): void;
  toThrowError(expected?: string | RegExp | Error | (new (...args: any[]) => any)): void;
  toBeInstanceOf(constructor: new (...args: any[]) => any): void;
  toMatchInlineSnapshot(snapshot?: string): void;
  /** Compare against a stored snapshot (`__snapshots__/velox.snap`); `velox test -u` updates it. */
  toMatchSnapshot(hint?: string): void;

  // spy / mock matchers
  toHaveBeenCalled(): void;
  toHaveBeenCalledTimes(times: number): void;
  toHaveBeenCalledWith(...args: unknown[]): void;
  toHaveBeenLastCalledWith(...args: unknown[]): void;
  toHaveBeenNthCalledWith(nth: number, ...args: unknown[]): void;
  toHaveReturned(): void;
  toHaveReturnedWith(value: unknown): void;

  /** Negates the matcher that follows. */
  readonly not: VeloxMatchers<T>;
  /** Unwraps a resolved promise, then applies the matcher to the value. */
  readonly resolves: VeloxMatchers<Awaited<T>>;
  /** Unwraps a rejected promise, then applies the matcher to the reason. */
  readonly rejects: VeloxMatchers<unknown>;
}

interface VeloxExpect {
  <T = unknown>(received: T): VeloxMatchers<T>;
  /** Matches any value created by the given constructor / of the given type. */
  any(constructor: unknown): VeloxAsymmetricMatcher;
  /** Matches anything but `null`/`undefined`. */
  anything(): VeloxAsymmetricMatcher;
  assertions(count?: number): void;
}

interface VeloxMock<TArgs extends any[] = any[], TReturn = any> {
  (...args: TArgs): TReturn;
  readonly mock: {
    calls: TArgs[];
    results: { type: "return" | "throw"; value: any }[];
    lastCall?: TArgs;
  };
  mockImplementation(fn: (...args: TArgs) => TReturn): this;
  mockImplementationOnce(fn: (...args: TArgs) => TReturn): this;
  mockReturnValue(value: TReturn): this;
  mockReturnValueOnce(value: TReturn): this;
  mockResolvedValue(value: Awaited<TReturn>): this;
  mockResolvedValueOnce(value: Awaited<TReturn>): this;
  mockRejectedValue(reason: unknown): this;
  mockReturnThis(): this;
  mockClear(): this;
  mockReset(): this;
  mockRestore?(): void;
}

interface VeloxVi {
  fn<TArgs extends any[] = any[], TReturn = any>(
    implementation?: (...args: TArgs) => TReturn,
  ): VeloxMock<TArgs, TReturn>;
  spyOn<T, K extends keyof T>(object: T, method: K): VeloxMock;
  isMockFunction(value: unknown): boolean;
  clearAllMocks(): VeloxVi;
  resetAllMocks(): VeloxVi;
  restoreAllMocks(): VeloxVi;
}

type VeloxTestFn = (done?: (error?: unknown) => void) => void | Promise<unknown>;

interface VeloxIt {
  (name: string, fn?: VeloxTestFn, timeout?: number): void;
  skip(name: string, fn?: VeloxTestFn): void;
  only(name: string, fn?: VeloxTestFn, timeout?: number): void;
  todo(name: string): void;
  each(
    cases: readonly unknown[],
  ): (name: string, fn: (...args: any[]) => void | Promise<unknown>, timeout?: number) => void;
}

interface VeloxDescribe {
  (name: string, fn: () => void): void;
  skip(name: string, fn: () => void): void;
  only(name: string, fn: () => void): void;
  todo(name: string): void;
}

declare const describe: VeloxDescribe;
declare const it: VeloxIt;
declare const test: VeloxIt;
declare const expect: VeloxExpect;
declare const vi: VeloxVi;
declare function beforeAll(fn: () => void | Promise<unknown>): void;
declare function afterAll(fn: () => void | Promise<unknown>): void;
declare function beforeEach(fn: () => void | Promise<unknown>): void;
declare function afterEach(fn: () => void | Promise<unknown>): void;

declare module "velox-test" {
  export const describe: VeloxDescribe;
  export const it: VeloxIt;
  export const test: VeloxIt;
  export const expect: VeloxExpect;
  export const vi: VeloxVi;
  export function beforeAll(fn: () => void | Promise<unknown>): void;
  export function afterAll(fn: () => void | Promise<unknown>): void;
  export function beforeEach(fn: () => void | Promise<unknown>): void;
  export function afterEach(fn: () => void | Promise<unknown>): void;
}
