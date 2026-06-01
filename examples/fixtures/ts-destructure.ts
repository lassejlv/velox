// Destructuring `export` declarations (object rename, array rest) — once a
// hard bundler error. Exercises the binding-name collector + live exports.
const src = { alpha: 1, beta: 2, gamma: 3 };
export const { alpha, beta: renamedBeta } = src;
export const [first, ...others] = [10, 20, 30];
