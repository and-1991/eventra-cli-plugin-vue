import pkg from "../package.json";
import { transformVueSfc } from "./transform";
import type { CliPluginVue } from "./types";

export function createCliPluginVue(): CliPluginVue {
  return {
    id: "vue",
    version: pkg.version,
    includeGlobs: ["**/*.vue"],
    staticSinks: [
      {
        id: "vue-template-event",
        callee: "__eventra_vue_template_event__",
        eventNameArgumentIndex: 0,
      },
    ],
    match: (path) => path.endsWith(".vue"),
    transform: transformVueSfc,
  };
}

export default createCliPluginVue();

export { transformVueSfc } from "./transform";
export { buildScriptModule, parseVueSfc, scriptVirtualPath } from "./parse-vue-sfc";
export type {
  CliPluginStaticCalleeSink,
  CliPluginTransformInput,
  CliPluginTransformResult,
  CliPluginVirtualModule,
  CliPluginVue,
} from "./types";
export type { ParsedVueSfc, TemplateEventBinding, VueScriptBlock } from "./parse-vue-sfc";
