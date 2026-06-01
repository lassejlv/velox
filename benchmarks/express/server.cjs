const express = require("express");
const app = express();
app.get("/json", (req, res) => res.json({ hello: "world", ts: Date.now() }));
app.get("/plaintext", (req, res) => { res.type("text/plain").send("Hello, World!"); });
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("ready:" + port));
