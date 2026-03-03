function hello(name) {
	console.log(name);
}
hello("name");
console.log("Hello from Velox!");
console.log("1 + 2 =", 1 + 2);
const greet = (name) => `Hello, ${name}!`;
console.log(greet("World"));
const posts = await fetch("https://jsonplaceholder.typicode.com/posts");
console.table(posts.json());
