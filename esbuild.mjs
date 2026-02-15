import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "fs";

const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const extensionBuildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
};

/** @type {esbuild.BuildOptions} */
const workerBuildOptions = {
  entryPoints: ["src/searchWorker.ts"],
  bundle: true,
  outfile: "dist/searchWorker.js",
  external: [],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
};

// Copy injected files to dist/injected/
mkdirSync("dist/injected", { recursive: true });
cpSync("injected", "dist/injected", { recursive: true });

if (watch) {
  const [extCtx, workerCtx] = await Promise.all([
    esbuild.context({
      ...extensionBuildOptions,
      plugins: [
        {
          name: "watch-notify",
          setup(build) {
            build.onStart(() => {
              cpSync("injected", "dist/injected", { recursive: true });
            });
            build.onEnd((result) => {
              if (result.errors.length > 0) {
                console.error("[watch] extension build failed");
              } else {
                console.log("[watch] extension build finished");
              }
            });
          },
        },
      ],
    }),
    esbuild.context({
      ...workerBuildOptions,
      plugins: [
        {
          name: "watch-notify-worker",
          setup(build) {
            build.onEnd((result) => {
              if (result.errors.length > 0) {
                console.error("[watch] worker build failed");
              } else {
                console.log("[watch] worker build finished");
              }
            });
          },
        },
      ],
    }),
  ]);
  await Promise.all([extCtx.watch(), workerCtx.watch()]);
  console.log("[watch] builds started");
} else {
  await Promise.all([
    esbuild.build(extensionBuildOptions),
    esbuild.build(workerBuildOptions),
  ]);
  console.log("[esbuild] builds complete");
}
