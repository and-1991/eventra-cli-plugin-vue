import { buildScriptModule, parseVueSfc, scriptVirtualPath } from "./parse-vue-sfc";
import type { CliPluginTransformInput, CliPluginTransformResult } from "./types";

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

  return {
    modules: [
      {
        path: scriptVirtualPath(input.path),
        content: buildScriptModule(parsed, input.path),
      },
    ],
  };
}
