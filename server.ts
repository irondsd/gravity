// `bun start` serves the game. `bun run dev` serves it with the tuning panel and hot reload.
import dev from "./dev.html";
import game from "./index.html";

const isDev = process.argv.includes("--dev");
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3210),
  routes: { "/": isDev ? dev : game },
  development: isDev ? { hmr: true, console: true } : false,
});

const url = server.url.href;
console.log(isDev ? `Gravity (dev mode, tuning panel on) at ${url}` : `Gravity is running. Play at ${url}   (Ctrl+C to quit)`);

// `bun start` opens the game in the default browser; pass --no-open to skip that.
if (!isDev && !process.argv.includes("--no-open")) {
  const opener = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn(opener, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // no browser opener on this system; the address is printed above
  }
}
