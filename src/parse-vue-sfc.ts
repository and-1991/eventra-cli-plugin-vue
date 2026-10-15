import fs from "node:fs";
import path from "node:path";

import { parse as parseSfc } from "@vue/compiler-sfc";
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

export interface ParsedVueSfc {
  readonly scripts: readonly VueScriptBlock[];
  readonly templateEvents: readonly TemplateEventBinding[];
  /**
   * Raw JS of the template's own code, copied verbatim: event handlers (`@click="() => track('x')"`,
   * `@click="a(); b()"`), `{{ }}` interpolations and the expressions of `v-bind`/`v-if`/`v-show`/...
   * Any call to a tracking function in there is an event the component fires.
   */
  readonly templateHandlers: readonly TemplateHandler[];
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

// the part of `item in items()` / `(item, i) of items()` that is an expression: after the `in` / `of`
const V_FOR_SOURCE = /\s(?:in|of)\s+([\s\S]+)$/;

// directives whose value is plain JS. `v-for` is handled apart (its value is `item in source`), and
// `v-slot` (a parameter list), `v-pre` and `v-cloak` hold no expression
const CODE_DIRECTIVES = new Set(["on", "bind", "if", "else-if", "show", "html", "text", "model"]);

function collectEventBindings(
  root: RootNode,
  out: TemplateEventBinding[],
  handlers: TemplateHandler[],
): void {
  function visitChildren(children: readonly TemplateChildNode[]): void {
    for (const child of children) {
      visitNode(child);
    }
  }

  function visitElementProps(props: readonly (AttributeNode | DirectiveNode)[]): void {
    for (const prop of props) {
      if (prop.type === NodeTypes.ATTRIBUTE && prop.name === "event") {
        const value = prop.value?.content?.trim();
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
        handlers.push({ handler: false, code: prop.arg.content.trim() });
      }
      if (prop.exp?.type !== NodeTypes.SIMPLE_EXPRESSION) continue;
      if (prop.name === "for") {
        const source = V_FOR_SOURCE.exec(prop.exp.content)?.[1]?.trim();
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
      visitElementProps((node as ElementNode).props);
      visitChildren(node.children);
      return;
    }
    // `{{ expr }}`
    if (node.type === NodeTypes.INTERPOLATION && node.content.type === NodeTypes.SIMPLE_EXPRESSION) {
      const code = node.content.content.trim();
      if (code) {
        handlers.push({ handler: false, code });
      }
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
  const template = descriptor.template;
  if (template) {
    if (template.ast) {
      collectEventBindings(template.ast, templateEvents, templateHandlers);
    } else {
      // @vue/compiler-sfc only ever leaves `ast` unset when `src` is set
      // (external template file) - the `else` here is a defensive fallback,
      // not a reachable third case
      /* v8 ignore else */
      if (template.src) {
        const external = readSrcFile(filePath, template.src);
        if (external) {
          collectEventBindings(parseTemplate(external), templateEvents, templateHandlers);
        }
      }
    }
  }

  return {
    scripts,
    templateEvents,
    // an empty expression (`@click=""`) holds no code
    templateHandlers: templateHandlers.filter((handler) => handler.code !== ""),
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
 */
export function buildScriptModule(parsed: ParsedVueSfc): string {
  const parts: string[] = [];

  if (parsed.scripts.length === 0) {
    parts.push("export {}");
  } else {
    // Only a leading `@ts-nocheck` is honoured by TypeScript, so only the
    // first block decides. Blocks keep their original line numbers.
    const first = parsed.scripts[0];
    const noCheck = first.lang !== "ts" && first.lang !== "tsx";
    parts.push(placeBlocks(parsed.scripts, noCheck ? "// @ts-nocheck" : undefined));
  }

  if (parsed.templateEvents.length > 0 || parsed.templateHandlers.length > 0) {
    const lines = [
      "// --- vue template (auto-generated) ---",
      `declare function ${TEMPLATE_EVENT_CALLEE}(name: string): void;`,
      "function __eventraVueTemplate() {",
      // template code goes through the same detection as script code, so a call to a tracking
      // function inside a handler or an interpolation is an event like any other
      ...parsed.templateHandlers.map(renderTemplateCode),
      ...parsed.templateEvents.map((binding) =>
        binding.kind === "literal"
          ? `  ${TEMPLATE_EVENT_CALLEE}("${escapeString(binding.value)}");`
          : `  ${TEMPLATE_EVENT_CALLEE}(${binding.value});`,
      ),
      "}",
    ];
    parts.push(lines.join("\n"));
  }

  return `${parts.join("\n\n")}\n`;
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
