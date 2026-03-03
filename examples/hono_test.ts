// Test actual Hono framework with Velox
import { Hono } from 'hono';

const app = new Hono();

app.get('/', (c) => {
  return c.text('Hello from Hono on Velox!');
});

app.get('/api/hello', (c) => {
  return c.json({ message: 'Hello, World!', runtime: 'Velox' });
});

app.get('/api/users/:id', (c) => {
  const id = c.req.param('id');
  return c.json({ user: { id, name: `User ${id}` } });
});

app.post('/api/echo', async (c) => {
  const body = await c.req.text();
  return c.json({ received: body });
});

// Create fetch handler
const handler = app.fetch.bind(app);

// Start server
Velox.serve({
  port: 3003,
  hostname: '127.0.0.1',
  handler,
  onError: (error) => {
    console.error('Server error:', error);
    return new Response(
      JSON.stringify({ error: error?.message || String(error) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  },
  onListen: (addr) => {
    console.log(`Hono server listening on http://${addr.hostname}:${addr.port}`);
  }
});
