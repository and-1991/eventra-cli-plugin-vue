import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createCliPluginVue } from "../src/index";
import { buildScriptModule, parseVueSfc, scriptVirtualPath } from "../src/parse-vue-sfc";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "checkout.vue",
);

describe("parseVueSfc", () => {
  it("extracts script setup and literal template event", () => {
    const source = readFileSync(FIXTURE, "utf8");
    const parsed = parseVueSfc(source, FIXTURE);

    expect(parsed.scripts).toHaveLength(1);
    expect(parsed.scripts[0]?.setup).toBe(true);
    expect(parsed.scripts[0]?.lang).toBe("ts");
    expect(parsed.scripts[0]?.content).toContain('tracker.track("checkout.started")');
    expect(parsed.templateEvents).toEqual([{ kind: "literal", value: "checkout.cta" }]);
  });

  it("builds the virtual module path", () => {
    expect(scriptVirtualPath("/src/App.vue")).toBe("/src/App.vue.ts");
  });

  it("ignores <script>/<template>-looking text inside HTML comments", () => {
    const source = `
      <!-- <script>evil()</script> -->
      <script setup lang="ts">track("real");</script>
      <template>
        <!-- <Button event="fake" /> -->
        <Button event="real_event" />
      </template>
    `;
    const parsed = parseVueSfc(source, "/virtual/Comment.vue");

    expect(parsed.scripts).toHaveLength(1);
    expect(parsed.scripts[0]?.content).toBe('track("real");');
    expect(parsed.templateEvents).toEqual([{ kind: "literal", value: "real_event" }]);
  });

  it("finds literal event bindings across nested elements, v-if/v-for, slots and multiple template roots", () => {
    const source = `
      <template>
        <Button event="root_a" />
        <div v-if="cond">
          <Button event="conditional" />
        </div>
        <Button v-for="item in items" :key="item.id" event="looped" />
        <template #footer>
          <Button event="slot_footer" />
        </template>
      </template>
    `;
    const parsed = parseVueSfc(source, "/virtual/Multi.vue");

    expect(parsed.templateEvents.map((e) => e.value)).toEqual([
      "root_a",
      "conditional",
      "looped",
      "slot_footer",
    ]);
  });

  it("drops an empty event=\"\" attribute instead of emitting a blank literal", () => {
    const parsed = parseVueSfc(
      '<template><Button event="" /></template>',
      "/EmptyLiteral.vue",
    );

    expect(parsed.templateEvents).toHaveLength(0);
  });

  it("drops an empty :event=\"\" binding instead of emitting a blank dynamic expression", () => {
    const parsed = parseVueSfc(
      '<template><Button :event="" /></template>',
      "/EmptyDynamic.vue",
    );

    expect(parsed.templateEvents).toHaveLength(0);
  });

  it("captures dynamic :event bindings as raw expressions instead of dropping them", () => {
    const source = `
      <template>
        <Button :event="computedName" />
        <Button v-bind:event="isActive ? 'a' : 'b'" />
      </template>
    `;
    const parsed = parseVueSfc(source, "/virtual/Dynamic.vue");

    expect(parsed.templateEvents).toEqual([
      { kind: "dynamic", value: "computedName" },
      { kind: "dynamic", value: "isActive ? 'a' : 'b'" },
    ]);
  });

  it("merges <script> and <script setup> in source order", () => {
    const source = `
      <script lang="ts">
      export const SHARED = "shared_event";
      </script>
      <script setup lang="ts">
      track(SHARED);
      </script>
    `;
    const parsed = parseVueSfc(source, "/virtual/TwoBlocks.vue");

    expect(parsed.scripts).toHaveLength(2);
    expect(parsed.scripts[0]?.setup).toBe(false);
    expect(parsed.scripts[0]?.content).toContain("SHARED");
    expect(parsed.scripts[1]?.setup).toBe(true);
    expect(parsed.scripts[1]?.content).toBe("track(SHARED);");
  });

  it("passes script setup macros through untouched", () => {
    const source = `
      <script setup lang="ts">
      const props = defineProps<{ eventName: string }>();
      track(props.eventName);
      </script>
    `;
    const parsed = parseVueSfc(source, "/virtual/Macros.vue");

    expect(parsed.scripts[0]?.content).toContain("defineProps<{ eventName: string }>()");
  });

  it("passes all script setup macros through untouched and still detects the sink call", () => {
    const source = `
      <script setup lang="ts">
      import { Eventra } from "@eventra_dev/eventra-sdk";

      defineOptions({ inheritAttrs: false });
      const props = withDefaults(defineProps<{ eventName?: string }>(), { eventName: "all_macros_event" });
      const emit = defineEmits<{ tracked: [name: string] }>();
      defineExpose({ props });

      const tracker = new Eventra({ apiKey: "k" });
      tracker.track(props.eventName);
      emit("tracked", props.eventName);
      </script>
      <template>
        <Button event="all_macros_template_event" />
      </template>
    `;
    const parsed = parseVueSfc(source, "/virtual/AllMacros.vue");

    const script = parsed.scripts[0]?.content ?? "";
    expect(script).toContain("defineOptions({ inheritAttrs: false });");
    expect(script).toContain("withDefaults(defineProps<{ eventName?: string }>()");
    expect(script).toContain("defineEmits<{ tracked: [name: string] }>();");
    expect(script).toContain("defineExpose({ props });");
    expect(script).toContain("tracker.track(props.eventName);");
    expect(parsed.templateEvents).toEqual([
      { kind: "literal", value: "all_macros_template_event" },
    ]);
  });

  it("resolves script src= and template src= external file references", () => {
    const fixture = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "src-blocks",
      "main.vue",
    );
    const source = readFileSync(fixture, "utf8");
    const parsed = parseVueSfc(source, fixture);

    expect(parsed.scripts).toHaveLength(1);
    expect(parsed.scripts[0]?.content).toContain('track("external_script_event")');
    expect(parsed.templateEvents).toEqual([
      { kind: "literal", value: "external_template_event" },
    ]);
  });

  it("skips a script/template src= pointing at a file that doesn't exist", () => {
    const parsed = parseVueSfc(
      '<script src="./does-not-exist.ts" lang="ts"></script>' +
        '<template src="./does-not-exist.html"></template>',
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "fixtures",
        "src-blocks",
        "main.vue",
      ),
    );

    expect(parsed.scripts).toHaveLength(0);
    expect(parsed.templateEvents).toHaveLength(0);
  });

  it("returns no scripts and no template events for an empty SFC", () => {
    const parsed = parseVueSfc("<template><div /></template>", "/Empty.vue");

    expect(parsed.scripts).toHaveLength(0);
    expect(parsed.templateEvents).toHaveLength(0);
  });
});

describe("buildScriptModule", () => {
  it("emits a single module with script content followed by the template-events function", () => {
    const parsed = parseVueSfc(readFileSync(FIXTURE, "utf8"), FIXTURE);
    const module = buildScriptModule(parsed);

    expect(module).toContain('tracker.track("checkout.started")');
    expect(module).toContain('__eventra_vue_template_event__("checkout.cta")');
  });

  it("emits dynamic bindings as raw (unquoted) expressions", () => {
    const parsed = parseVueSfc(
      '<template><Button :event="computedName" /></template>',
      "/virtual/Dynamic.vue",
    );
    const module = buildScriptModule(parsed);

    expect(module).toContain("__eventra_vue_template_event__(computedName);");
    expect(module).not.toContain('__eventra_vue_template_event__("computedName")');
  });

  it("resolves a dynamic binding through a real script-level const in the same module scope", () => {
    const source = `
      <script setup lang="ts">
      const eventName = "from_setup_const";
      </script>
      <template><Button :event="eventName" /></template>
    `;
    const parsed = parseVueSfc(source, "/virtual/Scoped.vue");
    const module = buildScriptModule(parsed);

    expect(module).toContain('const eventName = "from_setup_const"');
    expect(module).toContain("__eventra_vue_template_event__(eventName);");
  });

  it("adds a @ts-nocheck header for a plain JS script block (no lang=\"ts\")", () => {
    const parsed = parseVueSfc(
      '<script>track("plain_js_event");</script>',
      "/PlainJs.vue",
    );
    const module = buildScriptModule(parsed);

    expect(module).toContain("// @ts-nocheck");
    expect(module).toContain('track("plain_js_event")');
  });

  it("returns an export stub when there is no script and no template events", () => {
    const parsed = parseVueSfc("<template><div /></template>", "/Empty.vue");
    const module = buildScriptModule(parsed);

    expect(module.trim()).toBe("export {}");
  });
});

describe("createCliPluginVue", () => {
  it("returns a single virtual module combining script and template", async () => {
    const source = readFileSync(FIXTURE, "utf8");
    const plugin = createCliPluginVue();

    expect(plugin.match("App.vue")).toBe(true);
    expect(plugin.match("App.ts")).toBe(false);
    expect(plugin.includeGlobs).toContain("**/*.vue");
    expect(plugin.staticSinks?.[0]?.callee).toBe("__eventra_vue_template_event__");

    const result = await plugin.transform({ path: "/project/Checkout.vue", source });

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]?.path).toBe("/project/Checkout.vue.ts");
    expect(result.modules[0]?.content).toContain("checkout.started");
    expect(result.modules[0]?.content).toContain("checkout.cta");
  });

  it("returns an export stub when both script and template are missing", async () => {
    const plugin = createCliPluginVue();
    const result = await plugin.transform({ path: "/Empty.vue", source: "" });

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]?.content.trim()).toBe("export {}");
  });
});
