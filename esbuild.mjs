import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "fs";

const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
};

// Copy injected files to dist/injected/
mkdirSync("dist/injected", { recursive: true });
cpSync("injected", "dist/injected", { recursive: true });

if (watch) {
  const ctx = await esbuild.context({
    ...buildOptions,
    plugins: [
      {
        name: "watch-notify",
        setup(build) {
          build.onStart(() => {
            // Copy injected files on each rebuild
            cpSync("injected", "dist/injected", { recursive: true });
          });
          build.onEnd((result) => {
            if (result.errors.length > 0) {
              console.error("[watch] build failed");
            } else {
              console.log("[watch] build finished");
            }
          });
        },
      },
    ],
  });
  await ctx.watch();
  console.log("[watch] build started");
} else {
  await esbuild.build(buildOptions);
  console.log("[esbuild] build complete");
}
