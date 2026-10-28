<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra CLI Plugin — Vue

<p align="center">
  <a href="https://www.npmjs.com/package/@eventra_dev/cli-plugin-vue"><img alt="npm version" src="https://img.shields.io/npm/v/@eventra_dev/cli-plugin-vue.svg?style=flat-square&color=blue"></a>
  <a href="https://www.npmjs.com/package/@eventra_dev/cli-plugin-vue"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@eventra_dev/cli-plugin-vue.svg?style=flat-square&color=blue"></a>
  <img alt="tests passing" src="https://img.shields.io/badge/tests-127%20passing-brightgreen?style=flat-square&logo=vitest&logoColor=white">
  <img alt="coverage" src="https://img.shields.io/badge/coverage-100%25-brightgreen?style=flat-square&logo=vitest&logoColor=white">
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

### `<template>` - calls in handlers and expressions

Tracking calls written in the template itself are read, not only `event` attributes:

```vue
<template>
  <button @click="() => { open(); trackEvent('plan:cogm_open', { id }) }">Open</button>
  <p>{{ trackEvent('panel:viewed') }}</p>
</template>
```

Read: `@click` / `v-on` handlers (one or several statements, multi-line arrow functions), `{{ }}` interpolations the source of `v-for` (`item in items()`), dynamic arguments (`:[name()]`, `@[event()]`) and the expressions of `v-bind`, `v-if`, `v-else-if`, `v-show`, `v-model`, `v-html` and `v-text`. They are placed in the same module as the script, so a function imported or defined there resolves normally; an argument that comes from a `v-for` variable is reported as a dynamic occurrence. The loop variables of `v-for` and `v-slot` parameters are not code and are skipped; the value of a custom directive (`v-focus="x"`) is left alone.

### Props of a component, whatever they are called

The prop does not have to be named `event`. If a component sends one of its props to a tracking call, every place that uses the component with a value for that prop is an event:

```vue
<!-- Button.vue -->
<script setup lang="ts">
import { Eventra } from '@eventra_dev/eventra-sdk'
const tracker = new Eventra({ apiKey: 'YOUR_KEY' })
const props = defineProps<{ analyticsName: string }>()
function onClick() { tracker.track(props.analyticsName) }
</script>
<template><button @click="onClick"><slot /></button></template>

<!-- Page.vue -->
<script setup lang="ts">
import Button from './Button.vue'
</script>
<template><Button analytics-name="checkout.cta">Pay</Button></template>
```

`checkout.cta` is found. It works with `defineProps<{ ... }>()`, `defineProps([...])`, `defineProps({ ... })`, `withDefaults(...)`, a props object (`const props = defineProps(...)`) and a destructuring (`const { analyticsName } = defineProps(...)`), and also when the template reads the prop by its bare name (`@click="tracker.track(analyticsName)"`). A prop handed on to another component (`<Inner :name="props.analyticsName" />`) is followed. Props the component never tracks are not events. A prop that comes from a `v-for` variable is reported as a dynamic occurrence.

**Not followed** (those components are scanned as before, so nothing is lost, but a prop that only they use is not found):

- Options API components (`props: [...]` read through `this`).
- `v-bind="obj"` spreads.
- Components registered by name instead of imported, and dynamic components (`<component :is="X">`).
- Nuxt auto-imported components (used with no `import`): the tag is not matched to its file.
- A component whose normal `<script>` has its own `export default`, an `export` other than a type in `<script setup>`, an import after other code, or a `src=` script.

A value the CLI cannot resolve to a plain string (a `v-for` variable, a prop of the page itself) is listed under "Dynamic event names" instead of becoming an event. The same list shows the tracking call inside the component itself, one line per component, because what it tracks is whatever each caller passes; the callers that pass a literal are still found.

## Nuxt

Nuxt pages, layouts, and components are ordinary `.vue` SFCs — parsed identically, no extra configuration needed.

Composables auto-imported without an explicit `import` statement (Nuxt's own composables, or your own from `composables/`/`utils/`) are intended to resolve **once the project has run `nuxt prepare`/`nuxt dev`** (so `.nuxt/` exists and is wired into `tsconfig.json` - the CLI analyzes the project's real `tsconfig.json`, so Nuxt's generated ambient types are visible to it like any other TypeScript project). The host CLI's resolver understands the `declare const x: typeof import("./module")["name"]` shape Nuxt/`unplugin-auto-import` generate for these bindings (covered by a unit test with a hand-written fixture of that ambient shape, and verified manually end to end on a real Nuxt 3 project: after `nuxt prepare`, calls to an auto-imported composable that wraps `track()` were detected with no explicit `import`; without `.nuxt/` the same project yields no events). The end-to-end check is manual, not part of the automated test suite.

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

No dependency on `@eventra_dev/eventra-cli` - the CLI adapts this shape internally. `.vue` → one virtual `.vue.ts` module (compiled script content, then a function wrapping synthetic calls for every template `event="..."` binding and the handlers, interpolations and directive expressions copied from the template, under a `// --- vue template (auto-generated) ---` comment the CLI uses to tell generated code from your own lines). `staticSinks` describes those synthetic calls; the CLI builds its own sink detector from them. See [`@eventra_dev/eventra-cli`'s plugin docs](https://www.npmjs.com/package/@eventra_dev/eventra-cli#plugin-contract-for-authors) for the full external-plugin contract.

---

## Requirements

- Node.js 18+
- `@eventra_dev/eventra-cli` as the host CLI

---

## Test Coverage

**100% statement/branch/function/line coverage** (v8 provider, `pnpm test:coverage`), enforced via a `coverage.thresholds` block in `vitest.config.ts`.

**127 unit tests** (vitest), covering:

| Area | Covers |
|---|---|
| SFC parsing | Script + script-setup merge order, comment safety, `src=` external files |
| Template — literal | Nested elements, `v-if`/`v-for`, slots, multiple template roots |
| Template — dynamic | Raw expression passthrough, resolution through the merged script scope |
| Script-setup macros | All five compiler macros (`defineProps`/`defineEmits`/`defineExpose`/`defineOptions`/`withDefaults`) pass through without special-casing |
| Component props | `defineProps` in every spelling, props read through an object, a destructuring and bare template names, child components called with their props, name matching of tags to imports |
| Virtual module output | Single combined `.vue.ts`, export stub when script/template are empty |
| Plugin contract | `match()`, `includeGlobs`, `staticSinks`, `transform()` |

The Nuxt ambient auto-import shape (`declare const x: typeof import(...)`) is covered by a unit test in the host CLI that hand-writes that shape. A real `nuxt prepare` project was also checked end to end by hand, but that check is not part of the automated suite (see the [Nuxt](#nuxt) section above).

Run locally:

```bash
pnpm --filter @eventra_dev/cli-plugin-vue test
pnpm --filter @eventra_dev/cli-plugin-vue test:coverage
```

---

## License

MIT, copyright (c) 2026 [Yuriy Korolik](https://github.com/and-1991). See [LICENSE](LICENSE).
