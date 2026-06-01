// The shape TypeScript emits for an ESM enum: `export var E;` declared first,
// then populated by an IIFE *after* the export statement. Exercises velox's
// live-binding exports (a value-capture export would freeze E at `undefined`).
export var Color;
(function (Color) {
  Color["Red"] = "red";
  Color["Green"] = "green";
})(Color || (Color = {}));
