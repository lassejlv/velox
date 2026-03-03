// Hono-style Router Example for Velox
// This demonstrates how to build a Hono-compatible router pattern

class Router {
  constructor() {
    this.routes = [];
    this.middlewares = [];
  }

  use(middleware) {
    this.middlewares.push(middleware);
    return this;
  }

  get(path, handler) {
    return this.add("GET", path, handler);
  }

  post(path, handler) {
    return this.add("POST", path, handler);
  }

  put(path, handler) {
    return this.add("PUT", path, handler);
  }

  delete(path, handler) {
    return this.add("DELETE", path, handler);
  }

  add(method, path, handler) {
    // Convert path pattern to regex (simple implementation)
    // Supports :param style params
    const paramNames = [];
    const regexPattern = path.replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    const regex = new RegExp(`^${regexPattern}$`);

    this.routes.push({ method, path, handler, regex, paramNames });
    return this;
  }

  async handle(request) {
    // Extract path from URL
    const url = request.url;
    const path = url.startsWith("http") ? new URL(url).pathname : url;

    // Create context object (Hono-style)
    const ctx = {
      req: request,
      params: {},
      set: (key, value) => {
        ctx[key] = value;
      },
      get: (key) => ctx[key],
      json: (data, status = 200) => {
        return Response.json(data, { status });
      },
      text: (text, status = 200) => {
        return new Response(text, {
          status,
          headers: { "content-type": "text/plain" },
        });
      },
      html: (html, status = 200) => {
        return new Response(html, {
          status,
          headers: { "content-type": "text/html" },
        });
      },
      redirect: (url, status = 302) => {
        return Response.redirect(url, status);
      },
    };

    // Run middlewares
    for (const middleware of this.middlewares) {
      const result = await middleware(ctx);
      if (result instanceof Response) {
        return result;
      }
    }

    // Find matching route
    for (const route of this.routes) {
      if (route.method !== request.method) continue;

      const match = path.match(route.regex);
      if (match) {
        // Extract params
        route.paramNames.forEach((name, i) => {
          ctx.params[name] = match[i + 1];
        });

        // Call handler
        const result = await route.handler(ctx);
        if (result instanceof Response) {
          return result;
        }
      }
    }

    // 404 Not Found
    return new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  }

  // Create Velox.serve compatible handler
  fetch() {
    return (request) => this.handle(request);
  }
}

// Create a new router (Hono-style)
const app = new Router();

// Add logging middleware
app.use(async (ctx) => {
  const start = performance.now();
  console.log(`--> ${ctx.req.method} ${ctx.req.url}`);
  // Continue to next handler (return undefined to continue)
});

// Routes
app.get("/", (ctx) => {
  return ctx.html(`
    <h1>Velox + Hono-style Router</h1>
    <p>Welcome to the Hono-style routing example!</p>
    <ul>
      <li><a href="/api/hello">GET /api/hello</a></li>
      <li><a href="/api/users/123">GET /api/users/:id</a></li>
      <li><a href="/api/posts/456/comments/789">GET /api/posts/:postId/comments/:commentId</a></li>
    </ul>
  `);
});

app.get("/api/hello", (ctx) => {
  return ctx.json({ message: "Hello, World!" });
});

app.get("/api/users/:id", (ctx) => {
  return ctx.json({
    user: {
      id: ctx.params.id,
      name: `User ${ctx.params.id}`,
    },
  });
});

app.get("/api/posts/:postId/comments/:commentId", (ctx) => {
  return ctx.json({
    postId: ctx.params.postId,
    commentId: ctx.params.commentId,
    comment: "This is a sample comment",
  });
});

app.post("/api/echo", async (ctx) => {
  // Read request body
  const body = await ctx.req.text();
  return ctx.json({
    received: body,
    method: ctx.req.method,
  });
});

// Start server
Velox.serve({
  port: 3002,
  hostname: "127.0.0.1",
  handler: app.fetch(),
  onListen: (addr) => {
    console.log(`\nHono-style server listening on http://${addr.hostname}:${addr.port}`);
    console.log("Routes:");
    console.log("  GET  /");
    console.log("  GET  /api/hello");
    console.log("  GET  /api/users/:id");
    console.log("  GET  /api/posts/:postId/comments/:commentId");
    console.log("  POST /api/echo");
    console.log("\nPress Ctrl+C to stop\n");
  },
});
