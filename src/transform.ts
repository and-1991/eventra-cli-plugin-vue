import {
  buildScriptModule,
  buildTemplateModule,
  parseVueSfc,
  scriptVirtualPath,
  templateVirtualPath,
} from "./parse-vue-sfc";
import type { CliPluginTransformInput, CliPluginTransformResult, CliPluginVirtualModule } from "./types";

export async function transformVueSfc(
  input: CliPluginTransformInput,
): Promise<CliPluginTransformResult> {
  const parsed = parseVueSfc(input.source);
  const modules: CliPluginVirtualModule[] = [];

  modules.push({
    path: scriptVirtualPath(input.path),
    content: buildScriptModule(parsed.scripts),
  });

  const templateModule = buildTemplateModule(parsed.template);
  if (templateModule) {
    modules.push({
      path: templateVirtualPath(input.path),
      content: templateModule,
    });
  }

  return { modules };
}
