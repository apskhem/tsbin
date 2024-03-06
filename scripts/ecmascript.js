
const fs = require("fs");
const acorn = require("acorn");
const YAML = require("yaml");
const esbuild = require("esbuild");

const CODE_PATH = "tests/code/";
const PARSED_PATH = "tests/parsed/";
const FILE = "class"

const SHOULD_OPTIMIZE = false;

function parseECMAScript(code) {
  return acorn.parse(code, { ecmaVersion: 2022 });
}

let code = fs.readFileSync(`${CODE_PATH}${FILE}.txt`, "utf-8");
let error = null;

try {
  if (SHOULD_OPTIMIZE) {
    const output = esbuild.transformSync(code, {
      minifyIdentifiers: false,
      minifyWhitespace: true,
      minifySyntax: true,
      treeShaking: true,
    })
    code = output.code;
  }
} catch (err) {
  if (Array.isArray(err.errors) && err.errors[0]) {
    const { line, column } = err.errors[0].location
    error = { line, column, message: err.errors[0].text };
    console.error(error)
  }
}

try {
  const res = parseECMAScript(code)

  const content = YAML.stringify(res, null, 2);

  console.log(content.length)
  fs.writeFileSync(`${PARSED_PATH}${FILE}.yaml`, content)
} catch (err) {
  const { line, column } = err.loc;
  error = { line, column, message: err.message };
  console.error(error)
}
