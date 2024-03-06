import { parse } from "@typescript-eslint/parser";
import * as fs from "fs";

const content = fs.readFileSync("tests/samples/simple-1.ts", "utf-8");

const result = parse(content);

console.log(result);

fs.writeFileSync("dist/out.json", JSON.stringify(result, null, 2));