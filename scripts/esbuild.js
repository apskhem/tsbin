const { build } = require("esbuild");
const fs = require("fs");

const packageManifest = JSON.parse(fs.readFileSync("package.json", "utf-8"));

build({
  entryPoints: ["tsbin-parser/index.ts"],
  minify: true,
  sourcemap: true,
  bundle: true,
  platform: "node",
  target: ["node20"],
  packages: "external",
  outfile: "dist/index.js",
});