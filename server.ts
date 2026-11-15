import index from "./index.html";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3210),
  routes: { "/": index },
  development: { hmr: true, console: true },
});

console.log(`Gravity running at ${server.url}`);
