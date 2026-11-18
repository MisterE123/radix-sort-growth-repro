import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const cache = process.env.ROMAN_PARISH_CACHE;
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".webp": "image/webp" };

export async function serve(port = 0) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      const cached = cache && pathname.startsWith("/cache/");
      const base = cached ? resolve(cache) : root;
      const name = cached ? pathname.slice("/cache/".length) : pathname === "/" ? "index.html" : pathname.slice(1);
      const file = resolve(base, name);
      if (!file.startsWith(base + sep)) throw new Error("Outside server root");
      const info = await stat(file);
      if (!info.isFile()) throw new Error("Not a file");
      response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "content-length": info.size });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log((await serve(Number(process.argv[2] ?? 4173))).url);
}
