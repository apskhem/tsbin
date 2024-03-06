const fs = require("fs")
const { camelCase } = require("lodash");

const content = fs.readFileSync("tsbin-parser/encoders/ts5.proto", "utf-8")

const contentLines = content.split(/\r?\n/)

const parsed = new Map();
const parsingStack = [];
const listingNodes = [];
let currentNode = null;

function findParent(isCurrent = false) {
  let parentObj;
  for (const m of isCurrent ? parsingStack : parsingStack.slice(0, -1)) {
    parentObj = parentObj
      ? parentObj.insideMessages.get(m)
      : parsed.get(m)
  }
  return parentObj;
}

// parsing
for (const line of contentLines) {
  const sLine = line.trim();

  if (line.startsWith("message") && line.endsWith("Node {")) {
    const fLine = line.slice("message ".length, -"Node {".length)
    listingNodes.push(`${fLine} = "${fLine}",`);
  }

  if (sLine.startsWith("//") || !sLine) {
    continue;
  }

  if (sLine.includes("}")) {
    parsingStack.pop();
    currentNode = null;
    continue;
  }

  else if (sLine.includes("{")) {
    const [node, messageName] = sLine.split(/\s+/ig)
    parsingStack.push(messageName)

    if (parsingStack.length === 1) {
      currentNode = {
        insideMessages: new Map(),
        node,
        rawFields: new Map()
      };

      parsed.set(messageName, currentNode)
    }
    else {
      const parentObj = findParent();

      if (node === "oneof") {
        currentNode = []

        parentObj.rawFields.set(messageName, currentNode)
      } else {
        currentNode = {
          insideMessages: new Map(),
          node,
          rawFields: new Map()
        };

        parentObj.insideMessages.set(messageName, currentNode);
      }
    }
  }
  else {
    if (Array.isArray(currentNode)) {
      currentNode.push(sLine)
    } else {
      findParent(true)?.rawFields.set(sLine, null);
    }
  }
}

// transpiling
const templateLines = transpile(parsed, [])

function transpile(parsed, parentStack) {
  return [...parsed.entries()].flatMap(([key, { insideMessages, node, rawFields }]) => {
    if (node === "enum") {
      return genEnumEncoder(key, rawFields);
    } else if (node === "message") {
      const innerResults = transpile(insideMessages, [...parentStack, key])
      const passingKey = [...parentStack, key].join("_")

      return genMesseageEncoder(passingKey, rawFields, innerResults, Boolean(rawFields.get("kind")));
    } 
  })
}

fs.writeFileSync("src/encoders/ecmascript2022.ts", [
  `import * as proto from "generated/ecmascript2022";`,
  `import matchEncoding from "helpers/matchEncoding";`,
  `import interceptEnumError from "helpers/interceptEnumError";`,
  "",
  "export type ASTNode = {",
  "  type: string,",
  "  start: number,",
  "  end: number,",
  "  [x: string]: any",
  "}",
  "",
  "export const enum NodeType {",
  ...indent(2, listingNodes),
  "}",
  "",
  ...templateLines
].join("\n"))

// functions
function genEnumEncoder(enumName, rawFields) {
  const toMatches = []
  const formattedFields = [ ...rawFields.entries() ].map(([ rawField ]) => {
    const [ left, right ] = rawField.split(/=(.*)/s).map((p) => p.trim())
    const [ toMatch ] = extractAnnotation(right);
    toMatches.push(toMatch);

    return `if (value === "${toMatch}") return proto.${enumName}.${left.trim()};`
  })

  return [
    `export function encode${enumName}(value: string): proto.${enumName} {`,
    ...indent(2, formattedFields),
    "",
    "  throw {",
    `    expected: [`,
    ...indent(6, toMatches.map((s) => `"${s}",`)),
    `    ],`,
    `    found: value,`,
    "  };",
    "}",
    ""
  ]
}

function genMesseageEncoder(msgName, rawFields, embeds, isOneof = false) {
  const functionName = msgName.split("_").at(-1);

  let matcherArgument = "String(type), start, end";
  let functionParams = "{ type, start, end, ...props }"
  // special cases message
  if (msgName === "ArrayPatternNode_Element") {
    matcherArgument = `type ?? "null", start, end`
    functionParams = "ast"
    embeds = [ ...embeds, "const { type, start, end, ...props } = ast ?? {}" ]
  }

  return [
    `export function encode${functionName}(${functionParams}: ASTNode): proto.${msgName} {`,
    ...(embeds ? indent(2, embeds.map((line) => line.startsWith("export") ? line.slice("export ".length) : line)) : []),
    `  return matchEncoding<proto.${msgName}>(${matcherArgument})`,
    ...indent(4,
      isOneof
        ? genWithOneofFieldEncoder("kind", rawFields.get("kind"))
        // special case for LiteralNode_RegEx
        : genWithFieldEncoder(msgName, rawFields, msgName === "LiteralNode_RegEx" ? () => `"undefined"` : undefined)
      ),
    "    .end()",
    "}",
    ""
  ]
}

function genWithFieldEncoder(
  msgName,
  rawFields,
  formatMatcher = (msgName) => `NodeType.${removeNodeSuffix(msgName)}`
) {
  const props = [ ...rawFields.entries() ].flatMap(([ rawField, oneofFields ]) => {
    const sField = rawField.split("=")[0].trim();
    const splitFields = sField.split(/\s+/ig);
    const [modifier, type, name] = splitFields.length === 3 ? splitFields : [ null, ...splitFields ];

    const isObjectType = /^[A-Z]/.test(type);
    if (oneofFields) {
      // special cases oneof
      if (msgName === "LiteralNode") {
        return [
          `${type}: matchEncoding<proto.${msgName}["${type}"]>(props["${type}"] === null ? "null" : typeof props["${type}"], start, end)`,
          ...indent(2, genWithOneofFieldEncoder("", oneofFields)),
          "  .end(),",
        ];
      }

      return [
        `${type}: matchEncoding<proto.${msgName}["${type}"]>(props["${type}"].type, start, end)`,
        ...indent(2, genWithOneofFieldEncoder("", oneofFields, undefined, (dType) => `encode${dType}(props["${type}"])`)),
        "  .end(),",
      ]
    } else {
      let fieldValue;
      const [ replacer ] = extractAnnotation(rawField);
      if (parsed.get(type)?.node === "enum") {
        fieldValue = `interceptEnumError(() => encode${type}(${processProp(name, replacer)}), start, end)`
      } else if (isObjectType) {
        fieldValue = `encode${type}(${processProp(name, replacer)})`
      } else {
        fieldValue = `${processProp(name, replacer)}`
      }
  
      if (modifier === "optional") {
        fieldValue = `${processProp(name, replacer)} ? ${fieldValue} : undefined`
      }
  
      if (modifier === "repeated") {
        return ["start", "end"].includes(name)
          ? [`${name},`]
          : [`${camelCase(name)}: ${processProp(name, replacer)}.map((item: ASTNode) => encode${type}(item)),`];
      }
      else {
        return ["start", "end"].includes(name)
          ? [`${name},`]
          : [`${camelCase(name)}: ${fieldValue},`];
      }
    }
  });

  return [
    `.with(${formatMatcher(msgName)}, () => ({`,
    ...indent(2, props),
    "}))"
  ]
}

function genWithOneofFieldEncoder(
  fieldName,
  rawFields,
  formatMatcher = (type, fieldName) => `NodeType.${removeNodeSuffix(type)}`,
  formatValue = (type, fieldName) => `encode${type}({ type, start, end, ...props })`
) {
  return rawFields.flatMap((rawField) => {
    const [ type, name ] = rawField.split(/\s+/ig);
    const right = rawField.split("//")[1];

    const [ customMatcher, customDefualtValue ] = right ? extractAnnotation(right) : [];

    const tmp = fieldName ? [
        `${fieldName}: {`,
        `  oneofKind: "${camelCase(name)}",`,
        `  ${camelCase(name)}: ${customDefualtValue ?? formatValue(type, name)}`,
        `}`,
      ] : [
        `oneofKind: "${camelCase(name)}",`,
        `${camelCase(name)}: ${customDefualtValue ?? formatValue(type, name)}`,
      ]

    const isNodeType = type.endsWith("Node");
    const isNativeType =  type === type.toLowerCase()

    if (isNodeType || isNativeType) {
      return [
        `.with(${customMatcher ?? formatMatcher(type, name)}, () => ({`,
        ...indent(2, tmp),
        "}))"
      ]
    } else {
      const nodeTypes = extractKindTypes(parsed.get(type).rawFields.get("kind"))
        .map((t) => `${customMatcher ?? formatMatcher(t, name)},`)

      return [
        `.with([`,
        ...indent(2, nodeTypes),
        `], () => ({`,
        ...indent(2, tmp),
        "}))"
      ]
    }
  })
}

function processProp(propName, replacer) {
  return replacer ?? `props["${propName}"]`
}

function extractKindTypes(rawFields) {
  return rawFields.flatMap((rawField) => {
    const [ type ] = rawField.split(/\s+/ig);

    const isNodeType = type.endsWith("Node");
    
    return isNodeType
      ? [ type ] 
      : [ type ] // FIXME: extractKindTypes(parsed.get(type))
  })
}

function extractAnnotation(text) {
  const rawAnnotation = (/\(([^)]+)\)/ig).exec(text)?.[1] ?? ""
  const [ matcher = null, defualtValue = null ] = rawAnnotation.split(/:\s+/ig).filter(Boolean);
  return [ matcher, defualtValue ]
}

function removeNodeSuffix(text) {
  return text.replace(/Node$/ig, "")
}

function indent(space, lines) {
  return lines.map((l) => space ? " ".repeat(space) + l : l);
}
