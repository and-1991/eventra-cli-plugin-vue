import { describe, expect, it } from "vitest";

import { transformVueSfc } from "../src/transform";

const run = (source: string) => transformVueSfc({ path: "/p/A.vue", source });

describe("a template in another language", () => {
  it.each(["pug", "jade", "haml", "slm"])("says <template lang=%s> is not read, and still reads the script", async (lang) => {
    const result = await run(`<template lang="${lang}">\nbutton(@click="go")\n</template>\n<script setup>\nimport { Eventra } from "@eventra_dev/eventra-sdk";\nconst t = new Eventra({ apiKey: "k" });\nt.track("script.event");\n</script>\n`);
    expect(result.notes).toEqual([`<template lang="${lang}"> is not read: events written in it are not in the scan (script events are).`]);
    expect(result.modules[0].content).toContain("script.event");
  });

  it("is quiet for an ordinary template, and for lang=html", async () => {
    expect((await run(`<template><button event="x">go</button></template>`)).notes).toBeUndefined();
    expect((await run(`<template lang="html"><button event="x">go</button></template>`)).notes).toBeUndefined();
  });
});

describe("files a component is built from", () => {
  it("lists the files <script src> and <template src> point at, so watch can rescan the component when one changes", async () => {
    const result = await transformVueSfc({ path: "/p/src/A.vue", source: `<template src="./a.html"></template>\n<script src="../shared/a.ts"></script>\n` });
    expect(result.dependsOn).toEqual(["/p/shared/a.ts", "/p/src/a.html"]);
  });

  it("lists nothing for a component that is all in one file", async () => {
    expect((await transformVueSfc({ path: "/p/A.vue", source: `<template><p/></template>` })).dependsOn).toBeUndefined();
  });

  it("reads v-memo like the other directives that hold code", async () => {
    const result = await transformVueSfc({ path: "/p/B.vue", source: `<template><p v-memo="[track('memo.event')]"/></template>\n<script setup>\nimport { Eventra } from "@eventra_dev/eventra-sdk";\nconst t = new Eventra({ apiKey: "k" });\nfunction track(n) { t.track(n); }\n</script>\n` });
    expect(result.modules[0].content).toContain("track('memo.event')");
  });
});

describe("scripts in JSX, and files that are not there", () => {
  it("a script with lang=tsx or jsx is a .vue.tsx module, so JSX is not a syntax error; others stay .vue.ts", async () => {
    const tsx = await transformVueSfc({ path: "/p/A.vue", source: `<template><p/></template>\n<script lang="tsx">\nexport default { render() { return <div class="a">x</div>; } };\n</script>\n` });
    expect(tsx.modules[0].path).toBe("/p/A.vue.tsx");
    const jsx = await transformVueSfc({ path: "/p/B.vue", source: `<script lang="jsx">export default { render: () => <i/> };</script>\n` });
    expect(jsx.modules[0].path).toBe("/p/B.vue.tsx");
    const ts = await transformVueSfc({ path: "/p/C.vue", source: `<script lang="ts">export const a: number = 1;</script>\n` });
    expect(ts.modules[0].path).toBe("/p/C.vue.ts");
  });

  it("a <script src> or <template src> whose file is not there gets a note, an existing one does not", async () => {
    const result = await transformVueSfc({ path: "/p/src/A.vue", source: `<template src="./missing.html"></template>\n<script src="./missing.ts"></script>\n` });
    expect(result.notes).toEqual(['"./missing.ts" was not found: what it holds is not in the scan.', '"./missing.html" was not found: what it holds is not in the scan.']);
    const plain = await transformVueSfc({ path: "/p/A.vue", source: `<template><p/></template>` });
    expect(plain.notes).toBeUndefined();
  });
});
