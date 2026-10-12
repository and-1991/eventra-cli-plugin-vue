import { describe, expect, it } from "vitest";

import { transformVueSfc } from "../src/transform";

describe("transformVueSfc", () => {
  it("returns a single virtual module for a file with no errors and no events", async () => {
    const result = await transformVueSfc({ path: "/project/Plain.vue", source: "<template><div>hi</div></template>" });

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]?.path).toBe("/project/Plain.vue.ts");
  });

  it("throws (rather than silently returning an empty module) when the Vue parser reports an error", async () => {
    await expect(
      transformVueSfc({ path: "/project/Broken.vue", source: "<template><div></template>" }),
    ).rejects.toThrow(/Failed to parse Vue SFC .*Broken\.vue/);
  });
});

describe("transformVueSfc empty components", () => {
  it("does not treat a style-only component as a parse failure", async () => {
    const result = await transformVueSfc({
      path: "/project/Style.vue",
      source: "<style>.a { color: red }</style>",
    });

    expect(result.modules).toHaveLength(1);
  });
});
