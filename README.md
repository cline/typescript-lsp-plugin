# TypeScript Navigation Plugin for Cline CLI

A [Cline CLI](https://github.com/cline/cline) plugin that gives Cline a `goto_definition` tool powered by the TypeScript Language Service API.

Instead of relying on grep or text search, this plugin resolves symbol definitions through imports, re-exports, type aliases, barrel files, and more. It uses the same engine that powers "Go to Definition" in VS Code.

## Install

```bash
cline plugin install https://github.com/cline/typescript-lsp-plugin.git
```

Verify it's loaded:

```bash
cline config  # check the plugin tab
```

## How it works

Cline passes a file path and line number to the `goto_definition` tool. The plugin:

1. Walks up from the file to find the nearest `tsconfig.json`
2. Creates a TypeScript Language Service for that project
3. Scans the AST to find all identifiers on the given line
4. Resolves each identifier to its definition using `getDefinitionAtPosition`

The Language Service is cached per tsconfig, so repeated calls in the same project are fast.

TypeScript itself is resolved from the target project's `node_modules` at runtime, so this plugin has zero dependencies and uses whatever TS version the project is compiled with.

## Example

Given a file with this import on line 4:

```typescript
import { disposeAll, initVcr } from "@cline/shared"
```

The plugin resolves both symbols through the workspace package alias:

```
disposeAll -> packages/shared/src/dispose.ts:19
initVcr    -> packages/shared/src/vcr.ts:699
```

## Plugin manifest

This repo follows the Cline plugin manifest format. The `package.json` declares plugin entry points in a `cline` field:

```json
{
  "cline": {
    "plugins": [
      {
        "paths": ["./src/index.ts"],
        "capabilities": ["tools"]
      }
    ]
  }
}
```

See the [Cline plugin docs](https://docs.cline.bot/customization/plugins) for more on writing and distributing plugins.
