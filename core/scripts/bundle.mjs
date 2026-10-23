// Bundles moth-core (engine + MCP SDK + zod) into one CommonJS file for the Node single-executable build.
import { build } from "esbuild";
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/moth-core.cjs",
  legalComments: "none",
  logLevel: "info",
  // Node prints an ExperimentalWarning for node:sqlite; keep stderr clean for MCP clients.
  banner: { js: "process.removeAllListeners(\"warning\"); process.on(\"warning\", (w) => { if (w.name !== \"ExperimentalWarning\") console.error(w); });" },
});
