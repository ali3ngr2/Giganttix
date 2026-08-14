import esbuild from "esbuild";
import process from "process";
import { builtinModules as builtins } from "node:module";

const prod = process.argv[2] === "production";

// Plugin: silently drop any .scss or .css imports from node_modules
const ignoreStylesPlugin = {
  name: "ignore-styles",
  setup(build) {
    build.onResolve({ filter: /\.scss$/ }, (args) => ({
      path: args.path,
      namespace: "ignore-styles",
    }));
    build.onLoad({ filter: /.*/, namespace: "ignore-styles" }, () => ({
      contents: "",
      loader: "js",
    }));
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  plugins: [ignoreStylesPlugin],
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
