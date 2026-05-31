// Run with: cargo run -- examples/https-client.ts
import https from "node:https";

https.get("https://jsonplaceholder.typicode.com/users/1", (res: any) => {
  let body = "";
  res.on("data", (c: Buffer) => (body += c.toString()));
  res.on("end", () => {
    const user = JSON.parse(body);
    console.log(`${res.statusCode} → ${user.name} <${user.email}> @ ${user.company.name}`);
    process.exit(0);
  });
});
