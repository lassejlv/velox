// Demonstrates default, named and namespace imports across modules.
import square, { add, PI } from "./math"; // default + named
import * as math from "./math"; // namespace
import { Greeter, shout } from "./util"; // named (class + function)

const sum: number = add(2, 3);
console.log("add(2, 3) =", sum);
console.log("square(4) =", square(4));
console.log("PI =", PI);
console.log("math.multiply(6, 7) =", math.multiply(6, 7));
console.log("math.TAU =", math.TAU);

const greeter = new Greeter("velox");
console.log(greeter.greet());
console.log(shout("modules work"));
