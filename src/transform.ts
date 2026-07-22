import { buildScriptModule, parseVueSfc, scriptVirtualPath } from "./parse-vue-sfc";
import type { CliPluginTransformInput, CliPluginTransformResult } from "./types";

export async function transformVueSfc(
  input: CliPluginTransformInput,
): Promise<CliPluginTransformResult> {
  const parsed = parseVueSfc(input.source, input.path);

  return {
    modules: [
      {
        path: scriptVirtualPath(input.path),
        content: buildScriptModule(parsed),
      },
    ],
  };
}
