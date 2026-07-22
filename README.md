<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra CLI Plugin — Vue

<p align="center">
  <a href="https://www.npmjs.com/package/@eventra_dev/cli-plugin-vue"><img alt="npm version" src="https://img.shields.io/npm/v/@eventra_dev/cli-plugin-vue.svg?style=flat-square&color=blue"></a>
  <a href="https://www.npmjs.com/package/@eventra_dev/cli-plugin-vue"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@eventra_dev/cli-plugin-vue.svg?style=flat-square&color=blue"></a>
  <img alt="tests passing" src="https://img.shields.io/badge/tests-15%20passing-brightgreen?style=flat-square&logo=vitest&logoColor=white">
  <img alt="node" src="https://img.shields.io/node/v/@eventra_dev/cli-plugin-vue?style=flat-square&color=darkgreen&logo=node.js&logoColor=white">
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-blue?style=flat-square&logo=typescript&logoColor=white"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@eventra_dev/cli-plugin-vue?style=flat-square&color=lightgrey">
</p>

Official [**Eventra CLI**](https://www.npmjs.com/package/@eventra_dev/eventra-cli) plugin — extracts `track()` calls from Vue Single-File Components (`.vue`), so `eventra sync`/`check`/`watch` understand Vue and Nuxt code the same way they already understand plain TypeScript.

---

## Overview

The CLI core is framework-agnostic and only walks `.ts`/`.tsx`/`.js`/`.jsx`. This plugin teaches it `.vue`: it parses each SFC with the real Vue compiler ([`@vue/compiler-sfc`](https://www.npmjs.com/package/@vue/compiler-sfc)) — not a regex — and hands the CLI a single virtual TypeScript module per file, so every existing detection rule (direct SDK calls, function wrappers, cross-file propagation, dynamic-name reporting) applies to Vue code without any Vue-specific case in the core engine.

Vue and Nuxt `.vue` files are handled the same way — Nuxt pages/layouts/components are ordinary Vue SFCs. See [Nuxt](#nuxt) below for auto-import composables.

---

## Installation

```bash
npm install -D @eventra_dev/cli-plugin-vue @eventra_dev/eventra-cli
# or
pnpm add -D @eventra_dev/cli-plugin-vue @eventra_dev/eventra-cli
```

Enable it in `eventra.json`:

```json
{
  "plugins": ["@eventra_dev/cli-plugin-vue"],
  "sync": {
    "include": ["**/*.{ts,tsx,js,jsx}"],
    "exclude": ["node_modules", "dist", ".next", ".git"]
  }
}
```

`sync.include` does **not** need `**/*.vue` added manually — the plugin registers it via `includeGlobs`.

---

## What gets detected

### `<script>` / `<script setup>`

Handled exactly like a regular `.ts` file — direct SDK calls, function wrappers, variables, ternaries, cross-file propagation all apply:

```vue
<script setup lang="ts">
import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({ apiKey: "YOUR_PROJECT_API_KEY" });

tracker.track("checkout.started");
</script>
```

`<script>` + `<script setup>` in the same file are merged in source order. `defineProps`/`defineEmits`/`defineExpose`/`defineOptions`/`withDefaults` pass through untouched.

### `<template>` — literal event attributes

```vue
<template>
  <Button event="checkout.cta" />
</template>
```

### `<template>` — dynamic event attributes

```vue
<template>
  <Button :event="computedEventName" />
</template>
```

The expression is copied as-is into the same module scope as the script. If it resolves to a real script-level constant, the event name is detected normally; otherwise it's reported as a **dynamic occurrence** (same mechanism as `tracker.track(someVariable)` in plain TypeScript) instead of being silently dropped.

### External blocks

`<script src="./logic.ts">` and `<template src="./view.html">` are resolved and read from disk.

---

## Nuxt

Nuxt pages, layouts, and components are ordinary `.vue` SFCs — parsed identically, no extra configuration needed.

Composables auto-imported without an explicit `import` statement (Nuxt's own composables, or your own from `composables/`/`utils/`) resolve correctly **once the project has run `nuxt prepare`/`nuxt dev`** (so `.nuxt/` exists and is wired into `tsconfig.json` — the CLI analyzes the project's real `tsconfig.json`, so Nuxt's generated ambient types are visible to it like any other TypeScript project). This includes the case where a wrapper function that calls `track()` is only reachable via auto-import: the CLI understands the `declare const x: typeof import("./module")["name"]` shape Nuxt/`unplugin-auto-import` generate for these bindings.

---

## Configuration

No plugin-specific config — it activates purely by being listed in `eventra.json`'s `plugins` array (see [Installation](#installation)).

---

## Plugin contract

```ts
export interface CliPluginVue {
  readonly id: string;
  readonly version: string;
  readonly includeGlobs: readonly string[];
  readonly staticSinks?: readonly CliPluginStaticCalleeSink[];
  match(path: string): boolean;
  transform(input: { path: string; source: string }): Promise<{
    modules: Array<{ path: string; content: string }>;
  }>;
}
```

No dependency on `@eventra_dev/eventra-cli` — the CLI adapts this shape internally. `.vue` → one virtual `.vue.ts` module (compiled script content, then a function wrapping synthetic calls for every template `event="..."` binding). `staticSinks` describes those synthetic calls; the CLI builds its own sink detector from them. See [`@eventra_dev/eventra-cli`'s plugin docs](https://www.npmjs.com/package/@eventra_dev/eventra-cli#plugin-contract-for-authors) for the full external-plugin contract.

---

## Requirements

- Node.js 18+
- `@eventra_dev/eventra-cli` as the host CLI

---

## Test Coverage

**15 unit tests** (vitest), covering:

| Area | Covers |
|---|---|
| SFC parsing | Script + script-setup merge order, comment safety, `src=` external files |
| Template — literal | Nested elements, `v-if`/`v-for`, slots, multiple template roots |
| Template — dynamic | Raw expression passthrough, resolution through the merged script scope |
| Script-setup macros | `defineProps`/`defineEmits` pass through without special-casing |
| Virtual module output | Single combined `.vue.ts`, export stub when script/template are empty |
| Plugin contract | `match()`, `includeGlobs`, `staticSinks`, `transform()` |

Also validated end-to-end against real Vue and Nuxt projects (including Nuxt's own generated `.nuxt/` ambient types) as part of `@eventra_dev/eventra-cli`'s test suite.

Run locally:

```bash
pnpm --filter @eventra_dev/cli-plugin-vue test
```

---

## License

MIT
