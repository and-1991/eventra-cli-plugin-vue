import { describe, expect, it } from "vitest";

import { scriptBindings, wrapScriptSetup } from "../src/component";
import { buildScriptModule, parseVueSfc } from "../src/parse-vue-sfc";
import type { VueScriptBlock } from "../src/parse-vue-sfc";

function setup(content: string, lang = "ts"): VueScriptBlock {
  return { lang, setup: true, content, startLine: 1 };
}

function module(source: string, filePath = "/p/Button.vue"): string {
  return buildScriptModule(parseVueSfc(source, filePath), filePath);
}

describe("wrapScriptSetup", () => {
  it("makes the variable that holds defineProps the parameter", () => {
    const wrapped = wrapScriptSetup(setup("const props = defineProps<{ track: string; label: string }>();\nfunction go() { t(props.track); }"), "Button", new Set());
    expect(wrapped?.propNames).toEqual(["track", "label"]);
    expect(wrapped?.code).toBe("function Button(props: any) { const { track, label } = props;\nfunction go() { t(props.track); }");
  });

  it("uses a destructuring of defineProps as the parameter and adds the props it leaves out", () => {
    const wrapped = wrapScriptSetup(setup("const { track, label = 'x' } = defineProps<{ track: string; label?: string; other: string }>();"), "Button", new Set());
    expect(wrapped?.code).toContain("function Button({ track, label = 'x', other }: any) {");
  });

  it("keeps a destructuring that already names every prop as it is", () => {
    const wrapped = wrapScriptSetup(setup("const { track: renamed } = defineProps<{ track: string }>();"), "Button", new Set());
    expect(wrapped?.code).toContain("function Button({ track: renamed }: any) {");
  });

  it("takes the props of a bare defineProps from an array, an object, a type literal or a same-file type", () => {
    const names = (code: string): readonly string[] | undefined => wrapScriptSetup(setup(code), "B", new Set())?.propNames;
    expect(names("defineProps(['a', 'b']);")).toEqual(["a", "b"]);
    expect(names("defineProps({ a: String, 'b-c': { type: Number } });")).toEqual(["a", "b-c"]);
    expect(names("defineProps<{ a: string; b(): void }>();")).toEqual(["a", "b"]);
    expect(names("interface P { a: string }\ntype Q = P & { b: number };\ndefineProps<Q>();")).toEqual(["a", "b"]);
    expect(names("interface Base { a: string }\ninterface P extends Base { b: string }\ndefineProps<P>();")).toEqual(["b", "a"]);
  });

  it("sees through withDefaults and strips the export of a type", () => {
    const wrapped = wrapScriptSetup(setup("export interface Props { track: string }\nconst props = withDefaults(defineProps<Props>(), {});"), "Button", new Set());
    expect(wrapped?.code).toBe("function Button(props: any) { const { track } = props;interface Props { track: string }\n");
  });

  it("keeps every line where it was, and leaves the imports above the function", () => {
    const wrapped = wrapScriptSetup(setup("import x from 'x';\n\nconst props = defineProps<{ a: string }>();\n\nx(props.a);"), "B", new Set());
    expect(wrapped?.code).toBe("import x from 'x';\n\nfunction B(props: any) { const { a } = props;\n\nx(props.a);");
  });

  it("does not alias a prop to a name the script already declares", () => {
    const wrapped = wrapScriptSetup(setup("const props = defineProps<{ a: string; b: string }>();"), "B", new Set(["b"]));
    expect(wrapped?.code).toContain("const { a } = props;");
  });

  it("is async when the script awaits at the top level", () => {
    expect(wrapScriptSetup(setup("defineProps(['a']);\nawait load();"), "B", new Set())?.code).toMatch(/^async function B\(/);
  });

  it("leaves a block it does not follow alone", () => {
    const wrap = (block: VueScriptBlock): unknown => wrapScriptSetup(block, "B", new Set());
    expect(wrap(setup("const x = 1;"))).toBeNull();
    expect(wrap({ ...setup("defineProps(['a']);"), setup: false })).toBeNull();
    expect(wrap({ ...setup("defineProps(['a']);"), startLine: undefined })).toBeNull();
    expect(wrap(setup("defineProps(['a']);\nexport const x = 1;"))).toBeNull();
    expect(wrap(setup("defineProps(['a']);\nexport default {};"))).toBeNull();
    expect(wrap(setup("const a = 1;\nimport b from 'b';\ndefineProps(['a']);"))).toBeNull();
    expect(wrap(setup("const { a, ...rest } = defineProps(['a']);"))).toBeNull();
    expect(wrap(setup("const [a] = defineProps(['a']);"))).toBeNull();
    expect(wrap(setup("defineProps<Unknown>();"))).toBeNull();
    expect(wrap(setup("const x = {"))).toBeNull();
  });
});

describe("scriptBindings", () => {
  it("lists default imports as components and everything declared at the top level", () => {
    const bindings = scriptBindings([
      { lang: "ts", setup: false, content: "import A, { b } from 'a';\nimport type T from 't';\nexport const c = 1;" },
      setup("import D from 'd';\nconst { e, f: [g] } = x;\nfunction h() {}\nclass I {}\nlet [, j = 1, ...k] = y;"),
    ]);
    expect(bindings.components).toEqual(["A", "D"]);
    expect([...bindings.declared].sort()).toEqual(["A", "D", "I", "T", "b", "c", "e", "g", "h", "j", "k"]);
  });

  it("returns nothing for a block that does not parse", () => {
    expect(scriptBindings([setup("const = ;")])).toEqual({ components: [], declared: new Set(), hasDefaultExport: false });
  });
});

describe("buildScriptModule with props", () => {
  it("exports the component as a function of its props, with the template inside it", () => {
    const text = module(`<script setup lang="ts">
const props = defineProps<{ track: string }>();
</script>
<template><button @click="go(track)">x</button></template>`);
    expect(text).toBe(
      [
        "",
        "function Button(props: any) { const { track } = props;",
        "// --- vue template (auto-generated) ---",
        "  {",
        "go(track)",
        "  }",
        "// --- end template ---",
        "}",
        "export default Button;",
        "",
        "declare function __eventra_vue_template_event__(name: string): void;",
        "",
      ].join("\n"),
    );
  });

  it("closes the function when the template has nothing in it", () => {
    expect(module(`<script setup>\ndefineProps(['a']);\n</script>`)).toBe("// @ts-nocheck\nfunction Button({ a }: any) {\n}\nexport default Button;\n");
  });

  it("is scanned exactly as before when the component has no props", () => {
    expect(module(`<script setup lang="ts">\nconst a = 1;\n</script>\n<template><b :event="a" /></template>`)).toContain("function __eventraVueTemplate() {");
  });

  it("turns a use of an imported component into a call with its props", () => {
    const text = module(`<script setup lang="ts">
import Button from "./Button.vue";
import MyCard from "./MyCard.vue";
import { Other } from "./other";
</script>
<template>
  <div class="x">
    <Button track="a&quot;b" :label="text" analytics-name="n" :shorthand />
    <my-card :id="1" />
    <Other :n="1" />
    <Button disabled />
  </div>
</template>`);
    expect(text).toContain('  Button({ track: "a\\"b", label: (text\n), analyticsName: "n", shorthand: (shorthand\n) });');
    expect(text).toContain("  MyCard({ id: (1\n) });");
    // not a default import, and nothing passed
    expect(text).not.toContain("Other(");
    expect(text.match(/Button\(/g)).toHaveLength(1);
    expect(text).toContain("function __eventraVueTemplate() {");
  });

  it("matches a tag to its import the way Vue does", () => {
    const text = module(`<script setup>
import myButton from "./a.vue";
import Pascal from "./b.vue";
</script>
<template><my-button :a="1" /><pascal :b="2" /><Pascal :c="3" /></template>`);
    expect(text).toContain("myButton({ a: (1\n) });");
    expect(text).toContain("Pascal({ b: (2\n) });");
    expect(text).toContain("Pascal({ c: (3\n) });");
  });

  it("quotes a prop name that is not an identifier", () => {
    const text = module(`<script setup>\nimport B from "./b.vue";\n</script>\n<template><B data-x="1" /></template>`);
    expect(text).toContain('B({ dataX: "1" });');
  });

  it("names the component after its file and keeps the name clear of the script's own", () => {
    const code = `<script setup>\ndefineProps(['a']);\n</script>`;
    expect(module(code, "/p/my-page.vue")).toContain("function MyPage(");
    expect(module(code, "/p/[id].vue")).toContain("function Id(");
    expect(module(code, "/p/.vue")).toContain("function VueComponent(");
    expect(module(`<script setup>\nimport Button from "./x.vue";\ndefineProps(['a']);\n</script>`, "/p/Button.vue")).toContain("function ButtonComponent(");
  });

  it("wraps only the setup block and keeps a normal script above it", () => {
    const text = module(`<script>\nexport const kind = 1;\n</script>\n<script setup>\ndefineProps(['a']);\n</script>`);
    expect(text.indexOf("export const kind")).toBeLessThan(text.indexOf("function Button"));
  });

  it("does not wrap a setup block when a normal script declares the default export", () => {
    const text = module(`<script>\nexport default { name: "x" };\n</script>\n<script setup>\ndefineProps(['a']);\n</script>`);
    expect(text).not.toContain("function Button");
  });
});

describe("wrapScriptSetup: what the props are read from", () => {
  const names = (code: string): readonly string[] | undefined => wrapScriptSetup(setup(code), "B", new Set())?.propNames;

  it("skips what is not a named member of a type, and what it cannot read", () => {
    expect(names("defineProps<{ [key: string]: any; a: string; 'b-c': number; 0: string }>();")).toEqual(["a", "b-c"]);
    expect(names("defineProps<{ a: string }>(['x']);")).toEqual(["a", "x"]);
    expect(names("type Loop = Loop & { a: string };\ndefineProps<Loop>();")).toEqual(["a"]);
    expect(names("interface P extends NS.Base { a: string }\ndefineProps<P>();")).toEqual(["a"]);
    expect(names("interface P extends Unknown { a: string }\ndefineProps<P>();")).toEqual(["a"]);
    expect(names("type Q = string;\ntype R = { z: string };\ndefineProps<Q | R>();\ndefineProps<R>();")).toBeUndefined();
    expect(names("defineProps<NS.Props>();")).toBeUndefined();
  });

  it("reads the keys of an object and the strings of an array, and nothing else", () => {
    expect(names("defineProps({ a: String, ['b' + 'c']: String, d() {}, ...x, 'e-f': Number, [k]: 1 });")).toEqual(["a", "d", "e-f"]);
    expect(names("defineProps(['a', 1, , ...rest]);")).toEqual(["a"]);
    expect(names("defineProps(rest);")).toBeUndefined();
  });

  it("only takes the first defineProps, and ignores withDefaults of anything else", () => {
    expect(names("defineProps(['a']);\ndefineProps(['b']);")).toEqual(["a"]);
    expect(names("withDefaults(other(), {});\ndefineProps(['a']);")).toEqual(["a"]);
    expect(names("const x = 1, y = defineProps(['a']);")).toBeUndefined();
    expect(names("let x;\ndefineProps(['a']);")).toEqual(["a"]);
  });

  it("builds the parameter from a destructuring in its different spellings", () => {
    const parameter = (code: string): string | undefined => /function B\((.*?): any\)/.exec(wrapScriptSetup(setup(code), "B", new Set())?.code ?? "")?.[1];
    expect(parameter("const {} = defineProps(['a']);")).toBe("{ a }");
    expect(parameter("const { 'a-b': x } = defineProps(['a-b', 'c']);")).toBe("{ 'a-b': x, c }");
    expect(parameter("const { a }: Props = defineProps(['a', 'b']);")).toBe("{ a, b }");
    expect(parameter("const { [k]: x } = defineProps(['a']);")).toBe("{ [k]: x, a }");
    expect(parameter("const { 1: x } = defineProps(['a']);")).toBe("{ 1: x, a }");
    expect(parameter("const props = defineProps(['props', 'a']);")).toBe("props");
    expect(wrapScriptSetup(setup("const props = defineProps(['props']);"), "B", new Set())?.code).toBe("function B(props: any) {");
    expect(parameter("defineProps(['a-b', 'c']);")).toBe("{ c }");
  });

  it("does not wrap when no prop is a usable name", () => {
    expect(wrapScriptSetup(setup("defineProps(['a-b']);"), "B", new Set())).toBeNull();
    expect(wrapScriptSetup(setup("defineProps(['a']);"), "B", new Set(["a"]))).toBeNull();
  });
});

describe("scriptBindings: declarations", () => {
  it("reads object patterns with rest, defaults and exported declarations", () => {
    const bindings = scriptBindings([setup("export const { a, ...r } = x;\nconst [{ b } = {}] = y;\nexport function f() {}\nexport type T = 1;\nexport { a as z };")]);
    expect([...bindings.declared].sort()).toEqual(["a", "b", "f", "r"]);
    expect(bindings.hasDefaultExport).toBe(false);
    expect(scriptBindings([setup("export default {};")]).hasDefaultExport).toBe(true);
  });
});

describe("buildScriptModule: attributes of a child component", () => {
  it("quotes a prop whose name is not an identifier", () => {
    const text = module(`<script setup>\nimport B from "./b.vue";\n</script>\n<template><B a.b="1" :c.d="2" /></template>`);
    expect(text).toMatch(/B\(\{ "a\.b": "1", c: \(2\n\) \}\);/);
  });

  it("skips a binding with nothing to read, a dynamic argument and a boolean attribute", () => {
    const text = module(`<script setup>\nimport B from "./b.vue";\n</script>\n<template><B :[name]="1" v-if="ok" :empty="" disabled /><B v-bind="obj" /></template>`);
    expect(text).not.toContain("B(");
  });
});

describe("component.ts: parsing by language", () => {
  const declared = (lang: string, content: string): string[] => [...scriptBindings([{ lang, setup: false, content }]).declared];

  it("reads TypeScript only for ts and tsx, and JSX only for tsx and jsx", () => {
    expect(declared("ts", "const a: number = 1;")).toEqual(["a"]);
    expect(declared("tsx", "const a: number = 1;")).toEqual(["a"]);
    expect(declared("js", "const a: number = 1;")).toEqual([]);
    expect(declared("jsx", "const a: number = 1;")).toEqual([]);
    expect(declared("tsx", "const a = <b />;")).toEqual(["a"]);
    expect(declared("jsx", "const a = <b />;")).toEqual(["a"]);
    expect(declared("js", "const a = <b />;")).toEqual([]);
    expect(declared("ts", "const a = <b />;")).toEqual([]);
  });
});

describe("component.ts: exports", () => {
  const wrap = (code: string): ReturnType<typeof wrapScriptSetup> => wrapScriptSetup(setup(code), "B", new Set());

  it("sees a default export in any of the statements, and takes only a named export's declaration as declared", () => {
    expect(scriptBindings([setup("const a = 1;\nexport default {};\nconst b = 2;")]).hasDefaultExport).toBe(true);
    expect(scriptBindings([setup("const a = 1;")]).hasDefaultExport).toBe(false);
    expect([...scriptBindings([setup("export default function f() {}\nexport { g };")]).declared]).toEqual([]);
  });

  it("strips the export of a type alias as well as of an interface, wherever it is among the statements", () => {
    const wrapped = wrap("export type A = 1;\nexport interface B { b: string }\nconst props = defineProps<{ a: string }>();\nexport type C = 2;");
    expect(wrapped?.code).toBe("function B(props: any) { const { a } = props;type A = 1;\ninterface B { b: string }\n\ntype C = 2;");
  });

  it("does not follow an export of anything but a type", () => {
    expect(wrap("defineProps(['a']);\nexport * from 'x';")).toBeNull();
    expect(wrap("defineProps(['a']);\nexport { a };")).toBeNull();
    expect(wrap("defineProps(['a']);\nexport const a = 1;")).toBeNull();
  });

  it("does not look for the props in a declaration of several variables when the first one is not them", () => {
    expect(wrap("const a = defineProps(['a']), b = 2;")).toBeNull();
    expect(wrap("const a = 1, b = defineProps(['a']);")).toBeNull();
  });

  it("does not take an unrelated type for the props, and does not follow a type forever", () => {
    expect(wrap("interface A { a: string }\ninterface B { b: string }\ndefineProps<B>();")?.propNames).toEqual(["b"]);
    expect(wrap("interface P extends P { a: string }\ndefineProps<P>();")?.propNames).toEqual(["a"]);
  });

  it("follows a chain of type names up to a few steps", () => {
    expect(wrap("type A = B;\ntype B = C;\ntype C = D;\ntype D = { a: string };\ndefineProps<A>();")?.propNames).toEqual(["a"]);
  });

  it("uses a withDefaults without arguments as no props", () => {
    expect(wrap("withDefaults();\ndefineProps(['a']);")?.propNames).toEqual(["a"]);
  });

  it("ignores a call of a method named like a macro", () => {
    expect(wrap("a.defineProps(['a']);")).toBeNull();
  });
});

describe("component.ts: the parameter text", () => {
  const code = (source: string): string | undefined => wrapScriptSetup(setup(source), "B", new Set())?.code;

  it("joins the added props with a comma and a space", () => {
    expect(code("const { a } = defineProps(['a', 'b', 'c']);")).toContain("function B({ a, b, c }: any) {");
    expect(code("defineProps(['a', 'b']);")).toContain("function B({ a, b }: any) {");
    expect(code("const props = defineProps(['a', 'b', 'c']);")).toContain("const { a, b, c } = props;");
  });

  it("keeps a string key that names a prop, and a default that holds braces", () => {
    expect(code("const { 'a': x } = defineProps(['a']);")).toContain("function B({ 'a': x }: any) {");
    expect(code("const { a = {} } = defineProps(['a', 'c']);")).toContain("function B({ a = {}, c }: any) {");
  });

  it("drops the space before a type annotation", () => {
    expect(code("const { a } : Props = defineProps(['a']);")).toContain("function B({ a }: any) {");
    expect(code("const { a } : Props = defineProps(['a', 'b']);")).toContain("function B({ a, b }: any) {");
  });
});
