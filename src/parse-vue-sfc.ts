import fs from "node:fs";
import path from "node:path";

import { parse as parseSfc } from "@vue/compiler-sfc";
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
}

/** A single `event="..."` binding found on an element in the `<template>`. */
export interface TemplateEventBinding {
  /** `literal`: the event name is a string constant. `dynamic`: a raw JS/TS expression, copied verbatim. */
  readonly kind: "literal" | "dynamic";
  readonly value: string;
}

export interface ParsedVueSfc {
  readonly scripts: readonly VueScriptBlock[];
  readonly templateEvents: readonly TemplateEventBinding[];
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

function collectEventBindings(root: RootNode, out: TemplateEventBinding[]): void {
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
    const content = (block.src ? readSrcFile(filePath, block.src) : block.content)?.trim();
    if (!content) continue;
    scripts.push({
      lang: (block.lang ?? "js").toLowerCase(),
      setup: Boolean(block.setup),
      content,
    });
  }

  const templateEvents: TemplateEventBinding[] = [];
  const template = descriptor.template;
  if (template) {
    if (template.ast) {
      collectEventBindings(template.ast, templateEvents);
    } else if (template.src) {
      const external = readSrcFile(filePath, template.src);
      if (external) {
        collectEventBindings(parseTemplate(external), templateEvents);
      }
    }
  }

  return {
    scripts,
    templateEvents,
    errors: errors.map((error) => (error instanceof Error ? error.message : String(error))),
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
    for (const block of parsed.scripts) {
      const header = [`// --- vue script${block.setup ? " setup" : ""} ---`];
      if (block.lang !== "ts" && block.lang !== "tsx") {
        header.push("// @ts-nocheck");
      }
      parts.push([...header, block.content].join("\n"));
    }
  }

  if (parsed.templateEvents.length > 0) {
    const lines = [
      "// --- vue template (auto-generated) ---",
      `declare function ${TEMPLATE_EVENT_CALLEE}(name: string): void;`,
      "function __eventraVueTemplate() {",
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

function escapeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
