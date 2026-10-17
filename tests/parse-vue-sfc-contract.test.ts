import { describe, expect, it } from "vitest";

import { buildScriptModule, parseVueSfc, scriptVirtualPath, type ParsedVueSfc } from "../src/parse-vue-sfc";

// Exact-output tests: what each template construct becomes, field by field, and the exact virtual module text.

const parse = (template: string, script = "") =>
  parseVueSfc(`${script}<template>${template}</template>`, "/proj/App.vue");

const handlersOf = (template: string) => parse(template).templateHandlers;
const eventsOf = (template: string) => parse(template).templateEvents;

const CALLEE = "__eventra_vue_template_event__";

describe("event= and :event= bindings", () => {
  it("trims the value of a literal event attribute", () => {
    expect(eventsOf(`<a event="  signup  "></a>`)).toEqual([{ kind: "literal", value: "signup" }]);
  });

  it("ignores an event attribute with no value at all", () => {
    expect(eventsOf(`<a event></a>`)).toEqual([]);
  });

  it("trims a dynamic :event expression", () => {
    expect(eventsOf(`<a :event="  name  "></a>`)).toEqual([{ kind: "dynamic", value: "name" }]);
  });

  it("does not take other attributes or other bound arguments for an event", () => {
    expect(eventsOf(`<a name="x" :name="y" :event-name="z" :events="w"></a>`)).toEqual([]);
  });

  it("does not take a directive that is not v-bind for a dynamic event", () => {
    const parsed = parse(`<a @event="go()" v-show:event="x" v-if:event="y"></a>`);
    expect(parsed.templateEvents).toEqual([]);
  });

  it("does not take a bound dynamic argument that is merely called event for an event binding", () => {
    const parsed = parse(`<a :[event]="x"></a>`);
    expect(parsed.templateEvents).toEqual([]);
    expect(parsed.templateHandlers).toEqual([
      { handler: false, code: "event" },
      { handler: false, code: "x" },
    ]);
  });

  it("ignores a bare v-bind and a :event with no expression", () => {
    expect(eventsOf(`<a v-bind="props"></a>`)).toEqual([]);
    expect(eventsOf(`<a :event></a>`)).toEqual([]);
  });

  it("still reads a dynamic argument on a directive that is itself called event", () => {
    expect(handlersOf(`<a v-event:[dyn]="1"></a>`)).toEqual([{ handler: false, code: "dyn" }]);
  });
});

describe("template code: handlers and expressions", () => {
  it("trims every kind of expression", () => {
    expect(handlersOf(`<a @click="  go()  " :title="  t  " v-if="  ok  " v-show="  s  " v-html="  h  " v-text="  x  " v-model="  m  ">{{   c   }}</a>`)).toEqual([
      { handler: true, code: "go()" },
      { handler: false, code: "t" },
      { handler: false, code: "ok" },
      { handler: false, code: "s" },
      { handler: false, code: "h" },
      { handler: false, code: "x" },
      { handler: false, code: "m" },
      { handler: false, code: "c" },
    ]);
  });

  it("marks only v-on handlers as handlers", () => {
    expect(handlersOf(`<a v-on:click="a()" :x="b()" v-if="c()"></a>`).map((h) => h.handler)).toEqual([true, false, false]);
  });

  it("reads v-else-if, which is code like v-if", () => {
    expect(handlersOf(`<a v-if="a"></a><b v-else-if="b"></b>`)).toEqual([
      { handler: false, code: "a" },
      { handler: false, code: "b" },
    ]);
  });

  it("does not read directives that hold no expression: v-else, v-pre, v-cloak, v-slot", () => {
    expect(handlersOf(`<a v-if="a"></a><b v-else></b><c v-pre></c><d v-cloak></d>`)).toEqual([{ handler: false, code: "a" }]);
  });

  it("does not throw on a code directive written without a value", () => {
    expect(handlersOf(`<input v-model><a v-show></a><b v-if></b><c v-for></c>`)).toEqual([]);
  });

  it("takes the source of a v-for, as an expression and not a handler", () => {
    expect(handlersOf(`<li v-for="item in items"></li>`)).toEqual([{ handler: false, code: "items" }]);
  });

  it("takes a v-for source written with of, extra spaces, spaces inside, or a destructured loop variable", () => {
    expect(handlersOf(`<li v-for="item of  getItems(a, b)  "></li>`)).toEqual([{ handler: false, code: "getItems(a, b)" }]);
    expect(handlersOf(`<li v-for="({ a, b }, i) in list.filter((x) => x.ok)"></li>`)).toEqual([
      { handler: false, code: "list.filter((x) => x.ok)" },
    ]);
  });

  it("drops an interpolation that is empty or only whitespace", () => {
    expect(handlersOf(`<p>{{ }}</p><p>{{}}</p>`)).toEqual([]);
  });

  it("reads an interpolation outside any element", () => {
    expect(handlersOf(`{{ top }}`)).toEqual([{ handler: false, code: "top" }]);
  });

  it("keeps the order: arguments before values, props in source order, children after their parent", () => {
    expect(handlersOf(`<a @[ev]="h()" :x="x"><b v-if="y">{{ z }}</b></a>`).map((h) => h.code)).toEqual(["ev", "h()", "x", "y", "z"]);
  });
});

describe("scripts", () => {
  const scriptsOf = (source: string) => parseVueSfc(source, "/proj/App.vue").scripts;

  it("defaults the language to js, lower-cases an explicit one, and reports setup", () => {
    expect(scriptsOf(`<script>const a = 1;</script>`)).toEqual([{ lang: "js", setup: false, content: "const a = 1;", startLine: 1 }]);
    expect(scriptsOf(`<script setup lang="TS">const b = 2;</script>`)).toEqual([
      { lang: "ts", setup: true, content: "const b = 2;", startLine: 1 },
    ]);
  });

  it("gives the 1-based line of the first non-blank character of a script", () => {
    expect(scriptsOf(`<template><p/></template>\n\n<script>\n\n  const a = 1;\n</script>`)[0]).toMatchObject({ startLine: 5, content: "const a = 1;" });
  });
});

describe("scriptVirtualPath", () => {
  it("adds .ts after the final .vue only", () => {
    expect(scriptVirtualPath("/p/App.vue")).toBe("/p/App.vue.ts");
    expect(scriptVirtualPath("/p/App.VUE")).toBe("/p/App.vue.ts");
    expect(scriptVirtualPath("/pkg.vue/lib.vue-kit/App.vue")).toBe("/pkg.vue/lib.vue-kit/App.vue.ts");
  });

  it("leaves a path that does not end in .vue unchanged", () => {
    expect(scriptVirtualPath("/p/App.vue.ts")).toBe("/p/App.vue.ts");
    expect(scriptVirtualPath("/p/App.vuex")).toBe("/p/App.vuex");
  });
});

describe("buildScriptModule: exact text", () => {
  const parsed = (over: Partial<ParsedVueSfc> = {}): ParsedVueSfc => ({
    scripts: [],
    templateEvents: [],
    templateHandlers: [],
    errors: [],
    ...over,
  });

  it("is an export stub with a newline when there is nothing", () => {
    expect(buildScriptModule(parsed())).toBe("export {}\n");
  });

  it("puts the template function after the script, separated by one blank line, with exact lines", () => {
    const text = buildScriptModule(
      parsed({
        scripts: [{ lang: "ts", setup: false, content: "const a = 1;", startLine: 1 }],
        templateEvents: [{ kind: "literal", value: "signup" }, { kind: "dynamic", value: "name" }],
        templateHandlers: [{ handler: false, code: "x" }],
      }),
    );
    expect(text).toBe(
      [
        "const a = 1;",
        "",
        "// --- vue template (auto-generated) ---",
        `declare function ${CALLEE}(name: string): void;`,
        "function __eventraVueTemplate() {",
        "  (x",
        "  );",
        `  ${CALLEE}("signup");`,
        `  ${CALLEE}(name);`,
        "}",
        "",
      ].join("\n"),
    );
  });

  it("emits the template function for handlers alone, and for events alone", () => {
    expect(buildScriptModule(parsed({ templateHandlers: [{ handler: false, code: "x" }] }))).toContain("function __eventraVueTemplate() {");
    expect(buildScriptModule(parsed({ templateEvents: [{ kind: "literal", value: "e" }] }))).toContain("function __eventraVueTemplate() {");
  });

  it.each([
    ["ts", false],
    ["tsx", false],
    ["js", true],
    ["jsx", true],
    ["coffee", true],
  ])("a first %s script %s a @ts-nocheck header", (lang, header) => {
    const text = buildScriptModule(parsed({ scripts: [{ lang, setup: false, content: "x", startLine: 1 }] }));
    expect(text.startsWith("// @ts-nocheck\n")).toBe(header);
  });

  it("lets only the first block decide on @ts-nocheck", () => {
    const ts = { lang: "ts", setup: false, content: "a", startLine: 1 };
    const js = { lang: "js", setup: true, content: "b", startLine: 2 };
    expect(buildScriptModule(parsed({ scripts: [ts, js] }))).not.toContain("@ts-nocheck");
    expect(buildScriptModule(parsed({ scripts: [js, ts] }))).toContain("@ts-nocheck");
  });

  it("escapes backslashes and double quotes in a literal event name, in that order", () => {
    const line = (value: string) =>
      buildScriptModule(parsed({ templateEvents: [{ kind: "literal", value }] }))
        .split("\n")
        .find((l) => l.startsWith(`  ${CALLEE}(`));
    expect(line(String.raw`a\b`)).toBe(`  ${CALLEE}("a\\\\b");`);
    expect(line('say "hi"')).toBe(`  ${CALLEE}("say \\"hi\\"");`);
    expect(line(String.raw`a\"b`)).toBe(`  ${CALLEE}("a\\\\\\"b");`);
  });
});

describe("buildScriptModule: how template code is wrapped", () => {
  const render = (handler: boolean, code: string) =>
    buildScriptModule({ scripts: [], templateEvents: [], templateHandlers: [{ handler, code }], errors: [] })
      .split("\n")
      .slice(5, -2)
      .join("\n");

  it("wraps a handler in a block, and anything else in parentheses", () => {
    expect(render(true, "a(); b()")).toBe("  {\na(); b()\n  }");
    expect(render(false, "a + b")).toBe("  (a + b\n  );");
  });

  it("parenthesises a handler that is a bare function expression", () => {
    expect(render(true, "function () {}")).toBe("  (function () {}\n  );");
    expect(render(true, "function named() {}")).toBe("  (function named() {}\n  );");
  });

  it("parenthesises an async function handler, whatever the spacing", () => {
    expect(render(true, "async function () {}")).toBe("  (async function () {}\n  );");
    expect(render(true, "async   function () {}")).toBe("  (async   function () {}\n  );");
    expect(render(true, "async\tfunction () {}")).toBe("  (async\tfunction () {}\n  );");
  });

  it("keeps a handler in a block unless it starts with function: statements, names that merely contain it", () => {
    expect(render(true, "a(); function f() {}")).toBe("  {\na(); function f() {}\n  }");
    expect(render(true, "xfunction()")).toBe("  {\nxfunction()\n  }");
    expect(render(true, "functionality()")).toBe("  {\nfunctionality()\n  }");
    expect(render(true, "asyncXfunction()")).toBe("  {\nasyncXfunction()\n  }");
    expect(render(true, "async () => {}")).toBe("  {\nasync () => {}\n  }");
  });
});
