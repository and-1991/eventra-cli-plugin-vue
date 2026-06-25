export interface VueScriptBlock {
  readonly lang: string;
  readonly setup: boolean;
  readonly content: string;
}

export interface ParsedVueSfc {
  readonly scripts: readonly VueScriptBlock[];
  readonly template: string | null;
}

const SCRIPT_RE =
  /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

const TEMPLATE_RE =
  /<template\b[^>]*>([\s\S]*?)<\/template>/i;

function parseScriptAttrs(attrs: string): { lang: string; setup: boolean } {
  const langMatch = attrs.match(/\blang\s*=\s*["']([^"']+)["']/i);
  const lang = langMatch?.[1]?.toLowerCase() ?? "js";
  const setup = /\bsetup\b/i.test(attrs);
  return { lang, setup };
}

/** Extract `<script>` blocks and `<template>` body from a Vue SFC. */
export function parseVueSfc(source: string): ParsedVueSfc {
  const scripts: VueScriptBlock[] = [];

  for (const match of source.matchAll(SCRIPT_RE)) {
    const attrs = match[1] ?? "";
    const content = (match[2] ?? "").trim();
    if (!content) continue;

    const { lang, setup } = parseScriptAttrs(attrs);
    scripts.push({ lang, setup, content });
  }

  const templateMatch = source.match(TEMPLATE_RE);
  const template = templateMatch?.[1]?.trim() ?? null;

  return { scripts, template };
}

/** Map `App.vue` → `App.vue.ts` (virtual TS module for the compiler). */
export function scriptVirtualPath(vuePath: string): string {
  return vuePath.replace(/\.vue$/i, ".vue.ts");
}

/** Map `App.vue` → `App.vue.template.ts` (synthetic template refs). */
export function templateVirtualPath(vuePath: string): string {
  return vuePath.replace(/\.vue$/i, ".vue.template.ts");
}

/**
 * Build TypeScript from `<script>` blocks.
 * Non-TS blocks are wrapped in `// @ts-nocheck` so the scanner can still parse JS.
 */
export function buildScriptModule(scripts: readonly VueScriptBlock[]): string {
  if (scripts.length === 0) {
    return "export {}\n";
  }

  const parts = scripts.map((block, index) => {
    const header = [
      `// --- vue script block ${index + 1}${block.setup ? " (setup)" : ""} ---`,
    ];
    if (block.lang !== "ts" && block.lang !== "tsx") {
      header.push("// @ts-nocheck");
    }
    return [...header, block.content].join("\n");
  });

  return `${parts.join("\n\n")}\n`;
}

/**
 * Literal `event="feature_name"` attributes become synthetic calls for the
 * template sink (`__eventra_vue_template_event__`).
 */
export function buildTemplateModule(template: string | null): string | null {
  if (!template) return null;

  const literals: string[] = [];
  const literalEvent = /(?<![:\w])event\s*=\s*"([^"]+)"/gi;
  for (const match of template.matchAll(literalEvent)) {
    const name = match[1]?.trim();
    if (name) literals.push(name);
  }

  if (literals.length === 0) return null;

  const unique = [...new Set(literals)];
  const lines = [
    "// Auto-generated from Vue <template> — static literals only",
    "declare function __eventra_vue_template_event__(name: string): void;",
    ...unique.map((name) => `__eventra_vue_template_event__("${escapeString(name)}");`),
    "",
  ];

  return lines.join("\n");
}

function escapeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
