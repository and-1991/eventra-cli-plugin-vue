# @eventra_dev/cli-plugin-vue

Плагин для [Eventra CLI](https://eventra.dev): извлекает вызовы `track()` из Vue SFC (`.vue`).

Плагин **не зависит** от `@eventra_dev/eventra-cli` — у него свой контракт (`CliPluginVue`). CLI при загрузке адаптирует результат под внутренний формат.

## Установка

```bash
pnpm add -D @eventra_dev/cli-plugin-vue @eventra_dev/eventra-cli
```

## Конфигурация

```json
{
  "plugins": ["@eventra_dev/cli-plugin-vue"]
}
```

## Контракт

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

- `.vue` → виртуальные `.vue.ts` (script) и `.vue.template.ts` (литеральные `event="..."` в шаблоне)
- `staticSinks` описывают синтетические вызовы в шаблоне; CLI строит из них свой sink detector
