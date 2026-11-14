import { buildScriptModule, parseVueSfc, scriptVirtualPath } from "./parse-vue-sfc";
import type { CliPluginTransformInput, CliPluginTransformResult } from "./types";

const TEMPLATE_TAG = /<template\b/gi;
const NON_HTML_LANG = /\blang\s*=\s*["']?(pug|jade|haml|slm)\b/gi;

/**
 * The language of a template in another language than HTML (`<template lang="pug">`), whose events cannot be read:
 * what `/<template\b[^>]*\blang\s*=\s*["']?(pug|jade|haml|slm)\b/i` finds, without its cost. That pattern scanned
 * to the next `>` again from every `<template`, and a file with many of them and no `>` took minutes. Every
 * `<template` before the same `>` sees the same attributes or fewer, so only the first one is looked at, and each
 * part of the text is read once.
 */
export function nonHtmlTemplateLanguage(source: string): string | undefined {
  TEMPLATE_TAG.lastIndex = 0;
  for (let tag = TEMPLATE_TAG.exec(source); tag; tag = TEMPLATE_TAG.exec(source)) {
    const start = TEMPLATE_TAG.lastIndex;
    const close = source.indexOf(">", start);
    const end = close === -1 ? source.length : close;
    // the pattern took the last `lang=` before the `>`
    let language: string | undefined;
    for (const match of source.slice(start, end).matchAll(NON_HTML_LANG)) language = match[1];
    if (language) return language.toLowerCase();
    if (close === -1) return undefined;
    TEMPLATE_TAG.lastIndex = close + 1;
  }
  return undefined;
}

const EMPTY_SFC_ERROR = /^At least one <template> or <script> is required/;

export async function transformVueSfc(
  input: CliPluginTransformInput,
): Promise<CliPluginTransformResult> {
  const parsed = parseVueSfc(input.source, input.path);

  // A file with no <template>/<script> (empty or style-only) is a valid
  // zero-event component, not a parse failure.
  const errors = parsed.errors.filter((error) => !EMPTY_SFC_ERROR.test(error));

  if (errors.length > 0) {
    // A parse error means the compiler could not build a reliable tree -
    // continuing would silently under-report (or miss entirely) every
    // event in this file. Throwing surfaces it through the host CLI's
    // per-file "skip: <file> <message>" path instead of returning a module
    // that looks like a legitimate zero-event file.
    throw new Error(
      `Failed to parse Vue SFC ${input.path}: ${errors.join("; ")}`,
    );
  }

  const language = nonHtmlTemplateLanguage(input.source);
  const notes = language ? [`<template lang="${language}"> is not read: events written in it are not in the scan (script events are).`] : [];
  // a linked file that is not there is not an error (it may be generated), but nothing of it is in the scan
  for (const src of parsed.missingSrc) notes.push(`"${src}" was not found: what it holds is not in the scan.`);

  return {
    ...(notes.length > 0 ? { notes } : {}),
    ...(parsed.srcFiles.length > 0 ? { dependsOn: parsed.srcFiles } : {}),
    modules: [
      {
        path: scriptVirtualPath(input.path, parsed.scripts.some((script) => script.lang === "tsx" || script.lang === "jsx")),
        content: buildScriptModule(parsed, input.path),
      },
    ],
  };
}
