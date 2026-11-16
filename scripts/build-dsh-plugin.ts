import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build, type Plugin } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const packageRoot = resolve(root, "packages/dsh-plugin");
const outputRoot = resolve(packageRoot, "lib");

const inlineCss: Plugin = {
  name: "inline-css",
  setup(builder) {
    builder.onResolve({ filter: /\.css\?inline$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.slice(0, -"?inline".length)),
      namespace: "inline-css"
    }));
    builder.onLoad({ filter: /.*/, namespace: "inline-css" }, async (args) => ({
      contents: await readFile(args.path, "utf8"),
      loader: "text"
    }));
  }
};

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

await build({
  entryPoints: [resolve(packageRoot, "src/index.ts")],
  outfile: resolve(outputRoot, "index.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: false,
  treeShaking: true,
  packages: "bundle",
  external: ["@deepseek-ai/*"]
});

const hostEntry = resolve(outputRoot, "index.js");
await writeFile(hostEntry, (await readFile(hostEntry, "utf8")).replace(/[\t ]+$/gmu, ""));

await build({
  entryPoints: [resolve(packageRoot, "src/client/index.tsx")],
  outfile: resolve(outputRoot, "client.js"),
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: ["chrome120", "safari17"],
  sourcemap: false,
  treeShaking: true,
  define: { "process.env.NODE_ENV": '"production"' },
  minify: true,
  external: ["@deepseek-ai/*", "react", "react/jsx-runtime", "react-dom", "react-dom/client"],
  plugins: [inlineCss],
  banner: { js: "window.__ModuleLoader__.load({id:\"@oh-story/dsh\",factory:(require)=>{var module={exports:{}};var exports=module.exports;" },
  footer: { js: ";return module.exports;}});" }
});

// The long-serial workbench uses the author's original prompt. It deliberately
// ships no upstream writing workflow, roles, Python scripts, or media resources.
for (const excluded of ["oh-story", "drama", "novel-to-game", "video-recap"]) {
  const present = await access(resolve(outputRoot, excluded)).then(() => true, () => false);
  if (present) throw new Error(`Long-serial bundle retained an excluded upstream capability: ${excluded}`);
}

const hostBundle = await readFile(hostEntry, "utf8");
for (const forbidden of ["dsh-sdk-jsonrpc", "DeepSeekHarness", "FakeRuntimeAdapter", "NativeDshRuntimeAdapter", "EventSource"]) {
  if (hostBundle.includes(forbidden)) {
    throw new Error(`Native DSH plugin bundle retained forbidden parallel runtime code: ${forbidden}`);
  }
}

const clientEntry = resolve(outputRoot, "client.js");
const clientBundle = await readFile(clientEntry, "utf8");
for (const forbidden of ["react-dom.development", "react.development", "process.env.NODE_ENV"]) {
  if (clientBundle.includes(forbidden)) {
    throw new Error(`Browser bundle retained development runtime code: ${forbidden}`);
  }
}
const clientBytes = Buffer.byteLength(clientBundle);
if (clientBytes > 400_000) {
  throw new Error(`Browser bundle exceeds the 400 KB release budget: ${String(clientBytes)} bytes`);
}
