import { describe, expect, it } from "vitest";

import { firstContentLine, placeBlocks } from "../src/layout";
import { buildScriptModule, parseVueSfc } from "../src/parse-vue-sfc";

// the line a text appears on, 1-based
const lineOf = (text: string, needle: string): number =>
  text.split("\n").findIndex((l) => l.includes(needle)) + 1;

const SOURCE = `<template>
  <button :event="name">Pay</button>
</template>

<script setup lang="ts">
import { Eventra } from "@eventra_dev/eventra-sdk";
const name = "x";
const sdk = new Eventra({ apiKey: "k" });
sdk.track(name);
</script>
`;

describe("vue script module keeps original line numbers", () => {
  it("puts every script line on the line it has in the .vue file", () => {
    const module = buildScriptModule(parseVueSfc(SOURCE, "/p/A.vue"));

    for (const needle of ['import { Eventra }', 'const name = "x"', "sdk.track(name)"]) {
      expect(lineOf(module, needle)).toBe(lineOf(SOURCE, needle));
    }
  });

  it("keeps a non-ts script directly under the tag on its line, directive on line 1", () => {
    const source = '<script>\ntrack("a");\n</script>\n';
    const module = buildScriptModule(parseVueSfc(source, "/p/B.vue"));

    expect(module.split("\n")[0]).toBe("// @ts-nocheck");
    expect(lineOf(module, 'track("a")')).toBe(lineOf(source, 'track("a")'));
  });

  it("moves a one-line non-ts script down one line, since the directive owns line 1", () => {
    const source = '<script>track("a");</script>\n';
    const module = buildScriptModule(parseVueSfc(source, "/p/B2.vue"));

    expect(module.split("\n")[0]).toBe("// @ts-nocheck");
    expect(lineOf(module, 'track("a")')).toBe(2);
  });

  it("keeps the directive on line 1 and the code on its original line for a later non-ts script", () => {
    const source = "<template><i/></template>\n\n\n<script>\nfoo();\n</script>\n";
    const module = buildScriptModule(parseVueSfc(source, "/p/C.vue"));

    expect(module.split("\n")[0]).toBe("// @ts-nocheck");
    expect(lineOf(module, "foo()")).toBe(lineOf(source, "foo()"));
  });

  it("keeps both blocks of <script> + <script setup> on their lines", () => {
    const source = `<script lang="ts">
export const a = 1;
</script>

<script setup lang="ts">
const b = 2;
</script>
`;
    const module = buildScriptModule(parseVueSfc(source, "/p/D.vue"));

    expect(lineOf(module, "export const a")).toBe(2);
    expect(lineOf(module, "const b = 2")).toBe(6);
  });
});

describe("placeBlocks", () => {
  it("separates blocks by a blank line when a line is unknown", () => {
    expect(placeBlocks([{ content: "a();" }, { content: "b();" }])).toBe("a();\n\nb();");
  });

  it("keeps the directive on line 1 and starts an unplaced block right below it", () => {
    expect(placeBlocks([{ content: "a();" }], "// @ts-nocheck")).toBe("// @ts-nocheck\na();");
  });

  it("never moves a later block above the end of the previous one", () => {
    const out = placeBlocks([{ content: "a();\nb();", startLine: 1 }, { content: "c();", startLine: 1 }]);

    expect(out).toBe("a();\nb();\nc();");
  });

  it("counts the leading blank lines of a block", () => {
    expect(firstContentLine("\n\n  x", 3)).toBe(5);
    expect(firstContentLine("x", 3)).toBe(3);
  });
});
