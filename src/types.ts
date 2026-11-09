/** Input passed to a CLI plugin transform step. */
export interface CliPluginTransformInput {
  readonly path: string;
  readonly source: string;
}

/** Virtual module produced from a source file (e.g. Vue SFC → `.vue.ts`). */
export interface CliPluginVirtualModule {
  readonly path: string;
  readonly content: string;
}

/**
 * Declarative sink: match `CallExpression` by callee identifier and read the
 * event name from a string-literal argument. The CLI converts this to its
 * internal sink detector.
 */
export interface CliPluginStaticCalleeSink {
  readonly id: string;
  readonly callee: string;
  readonly eventNameArgumentIndex: number;
}

export interface CliPluginTransformResult {
  readonly modules: readonly CliPluginVirtualModule[];
  /** Hints about the file that are not errors (shown by the host CLI, never a failure). */
  readonly notes?: readonly string[];
  /** Other files the modules were built from: `eventra watch` rescans this file when one of them changes. */
  readonly dependsOn?: readonly string[];
}

/** Contract for `@eventra_dev/cli-plugin-vue` and compatible CLI plugins. */
export interface CliPluginVue {
  readonly id: string;
  readonly version: string;
  readonly includeGlobs: readonly string[];
  readonly staticSinks?: readonly CliPluginStaticCalleeSink[];
  match(path: string): boolean;
  transform(input: CliPluginTransformInput): Promise<CliPluginTransformResult>;
}
