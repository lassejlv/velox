// Run with: cargo run -- examples/hello.ts

interface Pet {
  name: string;
  kind: "cat" | "dog";
}

enum Mood {
  Happy,
  Sleepy,
}

const describe = (pet: Pet, mood: Mood): string =>
  `${pet.name} the ${pet.kind} is ${Mood[mood].toLowerCase()}`;

const pets: Pet[] = [
  { name: "Mochi", kind: "cat" },
  { name: "Rex", kind: "dog" },
];

for (const pet of pets) {
  console.log(describe(pet, Mood.Happy));
}

const names = pets.map((p) => p.name).join(", ");
console.info("pets:", names);

console.warn("this is a warning");
console.debug("and a debug line");
