import { babelParse } from "@vue/compiler-sfc";

import type { VueScriptBlock } from "./parse-vue-sfc";

// The structural part of a Babel node this file reads; the real types live in a package this one does not depend on.
interface BabelNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [key: string]: any;
}

export interface ComponentModule {
  /** The `<script setup>` text with a function header in front of its statements; the closing `}` is the caller's. */
  readonly code: string;
  /** Names the template (and `v-bind` of a parent) can pass as props. */
  readonly propNames: readonly string[];
  /** The function's name, which the module exports as its default after the closing brace. */
  readonly name: string;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Everything a script block declares at its top level, which the template can name. */
export interface ScriptBindings {
  /** Local names of default imports (`import Button from "./Button.vue"`): the components a template can use. */
  readonly components: readonly string[];
  readonly declared: ReadonlySet<string>;
  /** Some block has `export default`, which a component function exported as the default would clash with. */
  readonly hasDefaultExport: boolean;
}

function parseScript(block: Pick<VueScriptBlock, "lang" | "content">): BabelNode[] | null {
  const ts = block.lang === "ts" || block.lang === "tsx";
  const plugins: ("typescript" | "jsx")[] = [];
  if (ts) plugins.push("typescript");
  if (block.lang === "tsx" || block.lang === "jsx") plugins.push("jsx");
  try {
    return babelParse(block.content, { sourceType: "module", plugins }).program.body as unknown as BabelNode[];
  } catch {
    return null;
  }
}

function patternNames(pattern: BabelNode | null | undefined, out: Set<string>): void {
  if (!pattern) return;
  if (pattern.type === "Identifier") out.add(pattern.name);
  else if (pattern.type === "ObjectPattern") for (const property of pattern.properties) patternNames(property.type === "RestElement" ? property.argument : property.value, out);
  else if (pattern.type === "ArrayPattern") for (const element of pattern.elements) patternNames(element, out);
  else if (pattern.type === "AssignmentPattern") patternNames(pattern.left, out);
  else patternNames(pattern.argument, out); // RestElement
}

/** `export const a = 1` is the declaration it exports; anything else is itself. */
function unexported(statement: BabelNode): BabelNode {
  return statement.type === "ExportNamedDeclaration" && statement.declaration ? (statement.declaration as BabelNode) : statement;
}

function declaredNames(statements: readonly BabelNode[]): Set<string> {
  const out = new Set<string>();
  for (const raw of statements) {
    const statement = unexported(raw);
    if (statement.type === "VariableDeclaration") for (const declarator of statement.declarations) patternNames(declarator.id, out);
    else if ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") && statement.id) out.add(statement.id.name);
    else if (statement.type === "ImportDeclaration") for (const specifier of statement.specifiers) out.add(specifier.local.name);
  }
  return out;
}

/** The names a script block makes available to the template, or an empty set when it does not parse. */
export function scriptBindings(blocks: readonly VueScriptBlock[]): ScriptBindings {
  const components: string[] = [];
  const declared = new Set<string>();
  let hasDefaultExport = false;
  for (const block of blocks) {
    const statements = parseScript(block);
    if (!statements) continue;
    hasDefaultExport ||= statements.some((statement) => statement.type === "ExportDefaultDeclaration");
    for (const name of declaredNames(statements)) declared.add(name);
    for (const statement of statements) {
      if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportDefaultSpecifier") components.push(specifier.local.name);
      }
    }
  }
  return { components, declared, hasDefaultExport };
}

const isMacroCall = (node: BabelNode | null | undefined, name: string): boolean =>
  node?.type === "CallExpression" && node.callee.name === name;

/** `defineProps(...)` or `withDefaults(defineProps(...), {...})`, the call that declares the props. */
function propsCall(node: BabelNode | null | undefined): BabelNode | null {
  // `isMacroCall` is false for a missing node, so the assertions below only run on a real call
  if (isMacroCall(node, "defineProps")) return node!;
  if (isMacroCall(node, "withDefaults") && isMacroCall(node!.arguments[0], "defineProps")) return node!.arguments[0];
  return null;
}

function memberKeys(members: readonly BabelNode[], out: Set<string>): void {
  for (const member of members) {
    if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature") continue;
    const key = member.key as BabelNode;
    if (key.type === "Identifier") out.add(key.name);
    else if (key.type === "StringLiteral") out.add(key.value);
  }
}

function typeKeys(type: BabelNode, statements: readonly BabelNode[], out: Set<string>, depth = 0): void {
  if (depth > 4) return;
  if (type.type === "TSTypeLiteral") {
    memberKeys(type.members, out);
  } else if (type.type === "TSIntersectionType") {
    for (const part of type.types) typeKeys(part, statements, out, depth + 1);
  } else if (type.type === "TSTypeReference") {
    for (const raw of statements) {
      const statement = unexported(raw);
      if (statement.type === "TSInterfaceDeclaration" && statement.id.name === type.typeName.name) {
        memberKeys(statement.body.body, out);
        for (const parent of statement.extends ?? []) {
          typeKeys({ type: "TSTypeReference", typeName: parent.expression, start: 0, end: 0 }, statements, out, depth + 1);
        }
      } else if (statement.type === "TSTypeAliasDeclaration" && statement.id.name === type.typeName.name) {
        typeKeys(statement.typeAnnotation, statements, out, depth + 1);
      }
    }
  }
}

function propKeys(call: BabelNode, statements: readonly BabelNode[]): Set<string> {
  const out = new Set<string>();
  const typeArgument = call.typeParameters?.params?.[0] as BabelNode | undefined;
  if (typeArgument) typeKeys(typeArgument, statements, out);
  const argument = call.arguments[0] as BabelNode | undefined;
  if (argument?.type === "ArrayExpression") {
    for (const element of argument.elements) if (element?.type === "StringLiteral") out.add(element.value);
  } else if (argument?.type === "ObjectExpression") {
    for (const property of argument.properties) {
      if (property.type !== "ObjectProperty" && property.type !== "ObjectMethod") continue;
      if (property.key.type === "Identifier" && !property.computed) out.add(property.key.name);
      else if (property.key.type === "StringLiteral") out.add(property.key.value);
    }
  }
  return out;
}

/** Same text with every line break kept, so the lines after a removed statement keep their numbers. */
const blank = (text: string): string => text.replace(/[^\n]/g, "");

/**
 * Turns a `<script setup>` that declares props into the body of a function taking them, so the code
 * the compiler already understands (a parameter flowing into a track() call) applies to a component:
 *
 *   const props = defineProps<{ track: string }>()   ->   function Button(props) {
 *   const { track } = defineProps<...>()             ->   function Button({ track }) {
 *   defineProps(["track"])                           ->   function Button({ track }) {
 *
 * The imports stay above it, as they must; statements keep their line numbers. Returns null when the
 * block is not a setup block that declares props, or is written in a way this does not follow
 * (`export`s other than types, imports after other code, an external `src`), in which case the
 * component is scanned as before.
 */
export function wrapScriptSetup(block: VueScriptBlock, componentName: string, declaredElsewhere: ReadonlySet<string>): ComponentModule | null {
  if (!block.setup || block.startLine === undefined) return null;
  const statements = parseScript(block);
  if (!statements) return null;

  let firstBody = -1;
  const edits: { start: number; end: number; text: string }[] = [];
  let call: BabelNode | null = null;
  let id: BabelNode | null = null;

  for (const [index, statement] of statements.entries()) {
    if (statement.type === "ImportDeclaration") {
      if (firstBody !== -1) return null;
      continue;
    }
    if (firstBody === -1) firstBody = index;
    if (statement.type === "ExportNamedDeclaration") {
      const declaration = statement.declaration as BabelNode | null;
      if (!declaration || (declaration.type !== "TSInterfaceDeclaration" && declaration.type !== "TSTypeAliasDeclaration")) return null;
      edits.push({ start: statement.start, end: declaration.start, text: blank(block.content.slice(statement.start, declaration.start)) });
      continue;
    }
    if (statement.type === "ExportDefaultDeclaration" || statement.type === "ExportAllDeclaration") return null;
    const found = statement.type === "ExpressionStatement" ? propsCall(statement.expression) : statement.type === "VariableDeclaration" && statement.declarations.length === 1 ? propsCall(statement.declarations[0].init) : null;
    if (found && !call) {
      call = found;
      id = statement.type === "VariableDeclaration" ? (statement.declarations[0].id as BabelNode) : null;
      edits.push({ start: statement.start, end: statement.end, text: blank(block.content.slice(statement.start, statement.end)) });
    }
  }
  if (!call) return null;

  const names = [...propKeys(call, statements)];
  const present = new Set<string>();
  let parameter: string;
  let aliases = "";
  if (id?.type === "Identifier") {
    parameter = id.name;
    // the template names props bare, so each one is also a local that reads the same parameter path
    const bare = names.filter((name) => IDENTIFIER.test(name) && !declaredElsewhere.has(name) && name !== id!.name);
    if (bare.length > 0) aliases = ` const { ${bare.join(", ")} } = ${parameter};`;
  } else if (id?.type === "ObjectPattern") {
    // a rest element has to stay last, so nothing can be added after it
    if (id.properties.some((property: BabelNode) => property.type === "RestElement")) return null;
    // the keys read from the props, not the local names they are bound to: `{ track: renamed }` reads `track`
    for (const property of id.properties as BabelNode[]) {
      const key = property.key as BabelNode;
      if (key.type === "Identifier") present.add(key.name);
      else if (key.type === "StringLiteral") present.add(key.value);
    }
    const missing = names.filter((name) => IDENTIFIER.test(name) && !present.has(name) && !declaredElsewhere.has(name));
    const text = block.content.slice(id.start, id.typeAnnotation ? id.typeAnnotation.start : id.end).trim();
    parameter = missing.length > 0 ? text.replace(/\s*\}$/, `${id.properties.length > 0 ? "," : ""} ${missing.join(", ")} }`) : text;
  } else if (id === null) {
    const bare = names.filter((name) => IDENTIFIER.test(name) && !declaredElsewhere.has(name));
    if (bare.length === 0) return null;
    parameter = `{ ${bare.join(", ")} }`;
  } else {
    return null;
  }

  const header = `${/\bawait\b/.test(block.content) ? "async " : ""}function ${componentName}(${parameter}: any) {${aliases}`;

  // last edit first, so the offsets of the ones before it still hold
  let code = block.content;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  }
  // the header goes in front of the first statement, which no edit starts before
  const headerAt = statements[firstBody].start;
  code = code.slice(0, headerAt) + header + code.slice(headerAt);
  return { code, propNames: names, name: componentName };
}
