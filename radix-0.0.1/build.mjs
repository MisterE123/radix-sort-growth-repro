import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const [stock, patched, unmapped] = process.argv.slice(2);
if (!stock || !patched || !unmapped) throw new Error("Usage: node build.mjs stock/radix.module.js patched/radix.module.js unmapped/radix.module.js");
for (const [name, module] of [["stock", stock], ["patched", patched], ["unmapped", unmapped]]) {
  await build({
    entryPoints: [resolve(root, "source/app.js")],
    outfile: resolve(root, `app-${name}.js`),
    alias: { "@sparkjsdev/radix": resolve(module) },
    bundle: true, external: ["three", "three/*"], format: "esm", target: "chrome130", legalComments: "inline",
  });
}
