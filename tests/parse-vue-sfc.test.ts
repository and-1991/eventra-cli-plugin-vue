import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createCliPluginVue } from "../src/index";
import {
  buildTemplateModule,
  parseVueSfc,
  scriptVirtualPath,
  templateVirtualPath,
} from "../src/parse-vue-sfc";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "checkout.vue",
);

describe("parseVueSfc", () => {
  it("extracts script setup and template", () => {
    const source = readFileSync(FIXTURE, "utf8");
    const parsed = parseVueSfc(source);

    expect(parsed.scripts).toHaveLength(1);
    expect(parsed.scripts[0]?.setup).toBe(true);
    expect(parsed.scripts[0]?.lang).toBe("ts");
    expect(parsed.scripts[0]?.content).toContain('tracker.track("checkout.started")');
    expect(parsed.template).toContain('event="checkout.cta"');
  });

  it("builds virtual path names", () => {
    expect(scriptVirtualPath("/src/App.vue")).toBe("/src/App.vue.ts");
    expect(templateVirtualPath("/src/App.vue")).toBe("/src/App.vue.template.ts");
  });

  it("builds template module for literal event attributes", () => {
    const mod = buildTemplateModule('<Button event="checkout.cta" />');
    expect(mod).toContain('__eventra_vue_template_event__("checkout.cta")');
  });

  it("skips template module when no literal events", () => {
    expect(buildTemplateModule('<Button :event="dynamic" />')).toBeNull();
  });
});

describe("createCliPluginVue", () => {
  it("returns script + template virtual modules", async () => {
    const source = readFileSync(FIXTURE, "utf8");
    const plugin = createCliPluginVue();

    expect(plugin.match("App.vue")).toBe(true);
    expect(plugin.match("App.ts")).toBe(false);
    expect(plugin.includeGlobs).toContain("**/*.vue");
    expect(plugin.staticSinks?.[0]?.callee).toBe("__eventra_vue_template_event__");

    const result = await plugin.transform({
      path: "/project/Checkout.vue",
      source,
    });

    expect(result.modules).toHaveLength(2);
    expect(result.modules[0]?.path).toBe("/project/Checkout.vue.ts");
    expect(result.modules[0]?.content).toContain("checkout.started");
    expect(result.modules[1]?.path).toBe("/project/Checkout.vue.template.ts");
    expect(result.modules[1]?.content).toContain("checkout.cta");
  });

  it("returns export stub when script is missing", async () => {
    const plugin = createCliPluginVue();
    const result = await plugin.transform({
      path: "/Empty.vue",
      source: "<template><div /></template>",
    });

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]?.content.trim()).toBe("export {}");
  });
});
