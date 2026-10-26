import fs from "node:fs";
import path from "node:path";

import { parse as parseSfc } from "@vue/compiler-sfc";
import { scriptBindings, wrapScriptSetup } from "./component";
import { firstContentLine, placeBlocks } from "./layout";
import { parse as parseTemplate } from "@vue/compiler-dom";
import { NodeTypes } from "@vue/compiler-core";
import type {
  AttributeNode,
  DirectiveNode,
  ElementNode,
  RootNode,
  TemplateChildNode,
} from "@vue/compiler-core";

export interface VueScriptBlock {
  readonly lang: string;
  readonly setup: boolean;
  readonly content: string;
  /** 1-based line of the script's first character in the .vue file; unset for `src=` scripts. */
  readonly startLine?: number;
}

/** A single `event="..."` binding found on an element in the `<template>`. */
export interface TemplateEventBinding {
  /** `literal`: the event name is a string constant. `dynamic`: a raw JS/TS expression, copied verbatim. */
  readonly kind: "literal" | "dynamic";
  readonly value: string;
}

/** One piece of template code. A handler may be several statements; any other expression is a single one. */
export interface TemplateHandler {
  readonly handler: boolean;
  readonly code: string;
}

/** A prop passed to a child component in the template: `track="x"` (literal), `:track="expr"` (expression). */
export interface TemplateComponentProp {
  /** camelCased, the way the child declares it */
  readonly name: string;
  readonly kind: "literal" | "expression";
  readonly value: string;
}

/** An element that may be a child component, with the props written on it. Whether it is one depends on the script's imports. */
export interface TemplateComponentUsage {
  readonly tag: string;
  readonly props: readonly TemplateComponentProp[];
}

export interface ParsedVueSfc {
  readonly scripts: readonly VueScriptBlock[];
  readonly templateEvents: readonly TemplateEventBinding[];
  /**
   * Raw JS of the template's own code, copied verbatim: event handlers (`@click="() => track('x')"`,
   * `@click="a(); b()"`), `{{ }}` interpolations and the expressions of `v-bind`/`v-if`/`v-show`/...
   * Any call to a tracking function in there is an event the component fires.
   */
  readonly templateHandlers: readonly TemplateHandler[];
  /** Every element in the template that carries props, for the ones that turn out to be imported components. */
  readonly componentUsages?: readonly TemplateComponentUsage[];
  readonly errors: readonly string[];
}

function readSrcFile(sfcPath: string, src: string): string | null {
  const resolved = path.resolve(path.dirname(sfcPath), src);
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
}

const camelize = (name: string): string => name.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());

// the part of `item in items()` / `(item, i) of items()` that is an expression: after the `in` / `of`
const V_FOR_SOURCE = /\s(?:in|of)\s+([\s\S]+)$/;

// directives whose value is plain JS. `v-for` is handled apart (its value is `item in source`), and
// `v-slot` (a parameter list), `v-pre` and `v-cloak` hold no expression
const CODE_DIRECTIVES = new Set(["on", "bind", "if", "else-if", "show", "html", "text", "model"]);

function collectEventBindings(
  root: RootNode,
  out: TemplateEventBinding[],
  handlers: TemplateHandler[],
  usages: TemplateComponentUsage[],
): void {
  function visitChildren(children: readonly TemplateChildNode[]): void {
    for (const child of children) {
      visitNode(child);
    }
  }

  function collectComponentProps(tag: string, props: readonly (AttributeNode | DirectiveNode)[]): void {
    const found: TemplateComponentProp[] = [];
    for (const prop of props) {
      if (prop.type === NodeTypes.ATTRIBUTE) {
        if (prop.value) found.push({ name: camelize(prop.name), kind: "literal", value: prop.value.content });
        continue;
      }
      // `:track="expr"`; the same-name shorthand `:track` has no expression and reads the variable of that name
      if (prop.name === "bind" && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic) {
        const name = camelize(prop.arg.content);
        const expression = prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION ? prop.exp.content.trim() : name;
        if (expression) found.push({ name, kind: "expression", value: expression });
      }
    }
    if (found.length > 0) usages.push({ tag, props: found });
  }

  function visitElementProps(props: readonly (AttributeNode | DirectiveNode)[]): void {
    for (const prop of props) {
      if (prop.type === NodeTypes.ATTRIBUTE && prop.name === "event") {
        const value = prop.value?.content.trim();
        if (value) {
          out.push({ kind: "literal", value });
        }
        continue;
      }
      if (
        prop.type === NodeTypes.DIRECTIVE &&
        prop.name === "bind" &&
        prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION &&
        prop.arg.isStatic &&
        prop.arg.content === "event" &&
        prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION
      ) {
        const expr = prop.exp.content.trim();
        if (expr) {
          out.push({ kind: "dynamic", value: expr });
        }
        continue;
      }
      if (prop.type !== NodeTypes.DIRECTIVE) continue;
      // `:[expr]="..."` / `@[expr]="..."`: the argument is an expression of its own
      if (prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && !prop.arg.isStatic) {
        handlers.push({ handler: false, code: prop.arg.content });
      }
      if (prop.exp?.type !== NodeTypes.SIMPLE_EXPRESSION) continue;
      if (prop.name === "for") {
        const source = V_FOR_SOURCE.exec(prop.exp.content)?.[1].trim();
        if (source) {
          handlers.push({ handler: false, code: source });
        }
      } else if (CODE_DIRECTIVES.has(prop.name)) {
        handlers.push({ handler: prop.name === "on", code: prop.exp.content.trim() });
      }
    }
  }

  // `descriptor.template.ast` comes from the parse-only pass (no `transform()`
  // call), so `v-if`/`v-for` elements are still plain `ElementNode`s with the
  // directive attached in `props` — there is no separate IfNode/ForNode to
  // handle here.
  function visitNode(node: TemplateChildNode): void {
    if (node.type === NodeTypes.ELEMENT) {
      collectComponentProps((node as ElementNode).tag, (node as ElementNode).props);
      visitElementProps((node as ElementNode).props);
      visitChildren(node.children);
      return;
    }
    // `{{ expr }}`
    if (node.type === NodeTypes.INTERPOLATION && node.content.type === NodeTypes.SIMPLE_EXPRESSION) {
      // Vue already trims the expression; an empty `{{ }}` is dropped with the other empty expressions at the end of parseVueSfc
      handlers.push({ handler: false, code: node.content.content });
    }
  }

  visitChildren(root.children);
}

/** Parse a Vue SFC via the real `@vue/compiler-sfc` parser (handles comments, `src=`, malformed markup, etc). */
export function parseVueSfc(source: string, filePath: string): ParsedVueSfc {
  const { descriptor, errors } = parseSfc(source, { filename: filePath });

  const scripts: VueScriptBlock[] = [];
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block) continue;
    const raw = block.src ? readSrcFile(filePath, block.src) : block.content;
    const content = raw?.trim();
    if (!content) continue;
    scripts.push({
      lang: (block.lang ?? "js").toLowerCase(),
      setup: Boolean(block.setup),
      content,
      startLine: block.src ? undefined : firstContentLine(raw!, block.loc.start.line),
    });
  }

  const templateEvents: TemplateEventBinding[] = [];
  const templateHandlers: TemplateHandler[] = [];
  const componentUsages: TemplateComponentUsage[] = [];
  const template = descriptor.template;
  if (template) {
    if (template.ast) {
      collectEventBindings(template.ast, templateEvents, templateHandlers, componentUsages);
    } else {
      // @vue/compiler-sfc only ever leaves `ast` unset when `src` is set
      // (external template file) - the `else` here is a defensive fallback,
      // not a reachable third case
      /* v8 ignore else */
      if (template.src) {
        const external = readSrcFile(filePath, template.src);
        if (external) {
          collectEventBindings(parseTemplate(external), templateEvents, templateHandlers, componentUsages);
        }
      }
    }
  }

  return {
    scripts,
    templateEvents,
    // an empty expression (`@click=""`) holds no code
    templateHandlers: templateHandlers.filter((handler) => handler.code !== ""),
    componentUsages,
    errors: errors.map((error) => {
      // @vue/compiler-sfc errors are always Error instances
      /* v8 ignore else */
      if (error instanceof Error) return error.message;
      /* v8 ignore next */
      return String(error);
    }),
  };
}

/** Map `App.vue` → `App.vue.ts` (single virtual TS module for the compiler). */
export function scriptVirtualPath(vuePath: string): string {
  return vuePath.replace(/\.vue$/i, ".vue.ts");
}

const TEMPLATE_EVENT_CALLEE = "__eventra_vue_template_event__";

/**
 * Build one virtual TS module from the parsed SFC: compiled `<script>` +
 * `<script setup>` content, followed by a function wrapping synthetic calls
 * for every template `event="..."` binding. Because everything shares one
 * module scope, a dynamic binding (`:event="expr"`) that references a real
 * top-level script identifier (an imported constant, a `<script setup>`
 * const) resolves through the same checker-based pipeline as any other TS
 * expression; anything that doesn't resolve (e.g. a `v-for` loop variable)
 * is correctly reported as a dynamic occurrence rather than silently dropped.
 *
 * A component that declares props (`defineProps`) is also exported as a function of them, and every
 * use of it in another template becomes a call of that function. The prop that reaches a tracking
 * call is then found by what the component does with it, whatever the prop is called.
 */
export function buildScriptModule(parsed: ParsedVueSfc, filePath = ""): string {
  const parts: string[] = [];
  const bindings = scriptBindings(parsed.scripts);

  let scripts = parsed.scripts;
  let component: string | undefined;
  // only the last block can be wrapped: the function it opens stays open to the end of the module
  const last = parsed.scripts[parsed.scripts.length - 1];
  const others = last ? scriptBindings(parsed.scripts.slice(0, -1)) : undefined;
  if (last && !others?.hasDefaultExport) {
    const wrapped = wrapScriptSetup(last, componentName(filePath, bindings.declared), others!.declared);
    if (wrapped) {
      scripts = [...parsed.scripts.slice(0, -1), { ...last, content: wrapped.code }];
      component = wrapped.name;
    }
  }

  if (scripts.length === 0) {
    parts.push("export {}");
  } else {
    // Only a leading `@ts-nocheck` is honoured by TypeScript, so only the
    // first block decides. Blocks keep their original line numbers.
    const first = scripts[0];
    const noCheck = first.lang !== "ts" && first.lang !== "tsx";
    parts.push(placeBlocks(scripts, noCheck ? "// @ts-nocheck" : undefined));
  }

  const usages = componentCalls(parsed.componentUsages ?? [], bindings.components);
  if (parsed.templateEvents.length > 0 || parsed.templateHandlers.length > 0 || usages.length > 0) {
    const marker = "// --- vue template (auto-generated) ---";
    const body = [
      // template code goes through the same detection as script code, so a call to a tracking
      // function inside a handler or an interpolation is an event like any other
      ...parsed.templateHandlers.map(renderTemplateCode),
      ...usages,
      ...parsed.templateEvents.map((binding) =>
        binding.kind === "literal"
          ? `  ${TEMPLATE_EVENT_CALLEE}("${escapeString(binding.value)}");`
          : `  ${TEMPLATE_EVENT_CALLEE}(${binding.value});`,
      ),
    ];
    const declaration = `declare function ${TEMPLATE_EVENT_CALLEE}(name: string): void;`;
    if (component) {
      // inside the component function, where its props and script variables are in scope
      parts[0] = `${parts[0]}\n${[marker, ...body].join("\n")}\n// --- end template ---\n}\nexport default ${component};`;
      parts.push(declaration);
    } else {
      parts.push([marker, declaration, "function __eventraVueTemplate() {", ...body, "}"].join("\n"));
    }
  } else if (component) {
    parts[0] = `${parts[0]}\n}\nexport default ${component};`;
  }

  return `${parts.join("\n\n")}\n`;
}

/** `Button.vue` -> `Button`: the name the component is reported under, kept clear of the script's own names. */
function componentName(filePath: string, taken: ReadonlySet<string>): string {
  const base = path.basename(filePath).replace(/\.vue$/i, "");
  const name = base.replace(/(?:^|[^A-Za-z0-9]+)(\w)/g, (_, letter: string) => letter.toUpperCase()).replace(/[^\w$]/g, "");
  const valid = /^[A-Za-z_$][\w$]*$/.test(name) ? name : "VueComponent";
  return taken.has(valid) ? `${valid}Component` : valid;
}

const KEY = /^[A-Za-z_$][\w$]*$/;

/**
 * A use of an imported component in the template is a call of that component with its props object:
 * `<Button track="x" :label="text" />` is `Button({ track: "x", label: (text) })`. The tag is matched to
 * the import the way Vue does (`Button`, `button`, `my-button` for `MyButton`).
 */
function componentCalls(usages: readonly TemplateComponentUsage[], components: readonly string[]): string[] {
  const calls: string[] = [];
  for (const usage of usages) {
    const camel = usage.tag.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
    const pascal = camel.charAt(0).toUpperCase() + camel.slice(1);
    const binding = [usage.tag, camel, pascal].find((candidate) => components.includes(candidate));
    if (!binding) continue;
    const props = usage.props.map((prop) => {
      const key = KEY.test(prop.name) ? prop.name : `"${escapeString(prop.name)}"`;
      return `${key}: ${prop.kind === "literal" ? `"${escapeString(prop.value)}"` : `(${prop.value}\n)`}`;
    });
    calls.push(`  ${binding}({ ${props.join(", ")} });`);
  }
  return calls;
}

/**
 * A handler is a statement list when it is written as one (`a(); b()`), an expression otherwise
 * (`() => a()`, `handler`); both are valid as the body of a block, except a bare `function` which
 * would read as a declaration. Other expressions are parenthesised: `{ a: 1 }` is an object here.
 * The closing brace sits on its own line, so a trailing `// comment` cannot swallow it.
 */
function renderTemplateCode({ handler, code }: TemplateHandler): string {
  if (handler && !/^(async\s+)?function\b/.test(code)) {
    return `  {\n${code}\n  }`;
  }
  return `  (${code}\n  );`;
}

function escapeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
