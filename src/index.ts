import { createRequire } from "node:module"
import { resolve, dirname, join } from "node:path"
import { existsSync } from "node:fs"

/**
 * Cline CLI Plugin: TypeScript Navigation
 *
 * Provides go-to-definition using the TypeScript Language Service API.
 * Resolves `typescript` from the target project's node_modules at runtime,
 * so this plugin has zero dependencies of its own.
 *
 * Install with:
 *   clite plugin install https://github.com/cline/typescript-lsp-plugin.git
 *
 * Or copy to ~/.cline/plugins/ for manual installation.
 */

type TS = typeof import("typescript")

interface LanguageServiceCache {
	tsconfigPath: string
	service: ReturnType<TS["createLanguageService"]>
	ts: TS
}

// Cache the language service so repeated calls in the same project
// don't re-parse the entire program each time.
let cache: LanguageServiceCache | undefined

/**
 * Walk up the directory tree from `startDir` to find the nearest tsconfig.json.
 * This lets the plugin work even when Cline is run from a subdirectory.
 */
function findTsConfig(startDir: string): string | undefined {
	let dir = startDir
	while (true) {
		const candidate = join(dir, "tsconfig.json")
		if (existsSync(candidate)) return candidate
		const parent = dirname(dir)
		if (parent === dir) return undefined
		dir = parent
	}
}

/**
 * Resolve and load TypeScript from the target project's own node_modules.
 * This avoids bundling TypeScript as a dependency and ensures we use
 * the same version the project is compiled with.
 */
function loadTypeScript(projectDir: string): TS {
	const req = createRequire(resolve(projectDir, "package.json"))
	const tsPath = req.resolve("typescript")
	return req(tsPath) as TS
}

/**
 * Create a TypeScript Language Service for the given tsconfig.
 * The Language Service is what powers editor features like
 * go-to-definition, find-references, and completions in VS Code.
 */
function createService(ts: TS, tsconfigPath: string) {
	const projectDir = dirname(tsconfigPath)
	const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
	if (configFile.error) {
		throw new Error(
			"Failed to read tsconfig.json: " +
				ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
		)
	}

	const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectDir)

	// The LanguageServiceHost tells TypeScript how to read files and
	// what compiler options to use. We delegate to ts.sys for file I/O.
	const host: import("typescript").LanguageServiceHost = {
		getScriptFileNames: () => parsed.fileNames,
		getScriptVersion: () => "1",
		getScriptSnapshot: (fileName) => {
			const content = ts.sys.readFile(fileName)
			if (content === undefined) return undefined
			return ts.ScriptSnapshot.fromString(content)
		},
		getCurrentDirectory: () => projectDir,
		getCompilationSettings: () => parsed.options,
		getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory,
		getDirectories: ts.sys.getDirectories,
	}

	return ts.createLanguageService(host, ts.createDocumentRegistry())
}

/**
 * Get or create a cached Language Service for the given tsconfig path.
 * Caching avoids re-parsing the entire project on every tool call.
 */
function getOrCreateService(tsconfigPath: string) {
	if (cache && cache.tsconfigPath === tsconfigPath) {
		return cache
	}
	const projectDir = dirname(tsconfigPath)
	const ts = loadTypeScript(projectDir)
	const service = createService(ts, tsconfigPath)
	cache = { tsconfigPath, service, ts }
	return cache
}

/** Convert a 0-based character offset to 1-based line and column numbers. */
function offsetToLineCol(sourceFile: import("typescript").SourceFile, ts: TS, offset: number) {
	const lc = ts.getLineAndCharacterOfPosition(sourceFile, offset)
	return { line: lc.line + 1, column: lc.character + 1 }
}

/**
 * Find all identifier positions on a given line by walking the AST.
 * This is how we discover which symbols to resolve -- we scan the
 * syntax tree rather than doing regex matching on the source text.
 */
function getIdentifierOffsetsOnLine(
	ts: TS,
	sourceFile: import("typescript").SourceFile,
	targetLine: number,
) {
	const offsets: number[] = []

	function visit(node: import("typescript").Node) {
		if (ts.isIdentifier(node)) {
			const lc = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile))
			if (lc.line + 1 === targetLine) {
				offsets.push(node.getStart(sourceFile))
			}
		}
		ts.forEachChild(node, visit)
	}

	visit(sourceFile)
	return offsets
}

/**
 * The plugin object follows the Cline AgentExtension interface.
 *
 * It registers a single tool: `goto_definition`, which accepts a file path
 * and line number, finds all identifiers on that line, and resolves where
 * each one is defined using the TypeScript Language Service.
 *
 * This is much more precise than grep/text search because it resolves
 * through imports, re-exports, type aliases, barrel files, etc.
 */
const plugin = {
	name: "typescript-nav",
	manifest: {
		capabilities: ["tools" as const],
	},
	setup(api: {
		registerTool: (tool: {
			name: string
			description: string
			inputSchema: Record<string, unknown>
			timeoutMs?: number
			retryable?: boolean
			execute: (input: unknown, context: unknown) => Promise<unknown>
		}) => void
	}) {
		api.registerTool({
			name: "goto_definition",
			description:
				"Find where TypeScript/JavaScript symbols on a given line are defined. Given a file path and line number, finds all identifiers on that line and resolves their definitions using the TypeScript Language Service API. Much more precise than text search -- resolves through imports, re-exports, type aliases, etc.",
			inputSchema: {
				type: "object",
				properties: {
					file: {
						type: "string",
						description: "Absolute path to the file.",
					},
					line: {
						type: "integer",
						description: "Line number (1-based).",
					},
				},
				required: ["file", "line"],
				additionalProperties: false,
			},
			timeoutMs: 30_000,
			retryable: false,
			async execute(input) {
				const args = input as { file: string; line: number }
				const fileName = resolve(args.file)

				if (!existsSync(fileName)) {
					throw new Error("File does not exist: " + fileName)
				}

				// Walk up from the file to find the nearest tsconfig.json
				const tsconfigPath = findTsConfig(dirname(fileName))
				if (!tsconfigPath) {
					throw new Error(
						"No tsconfig.json found in any parent directory of " + fileName,
					)
				}

				const { ts, service } = getOrCreateService(tsconfigPath)

				const program = service.getProgram()
				if (!program) throw new Error("Failed to create TypeScript program")

				const sourceFile = program.getSourceFile(fileName)
				if (!sourceFile) {
					throw new Error(
						"File not found in TypeScript program. Make sure it is included by tsconfig.json: " +
							fileName,
					)
				}

				// Find all identifiers on the requested line by walking the AST
				const identifierOffsets = getIdentifierOffsetsOnLine(ts, sourceFile, args.line)

				if (identifierOffsets.length === 0) {
					return {
						found: false,
						file: args.file,
						line: args.line,
						message: "No identifiers found on this line.",
					}
				}

				const results: Array<{
					symbol: string
					definitions: Array<{
						file: string
						line: number
						column: number
						kind: string
						name: string
						containerName?: string
					}>
				}> = []

				const seen = new Set<string>()

				for (const offset of identifierOffsets) {
					const token = ts.getTokenAtPosition(sourceFile, offset)
					const symbolName = token.getText(sourceFile)

					// Skip duplicate symbol names on the same line
					if (seen.has(symbolName)) continue
					seen.add(symbolName)

					// Use the Language Service to resolve the definition
					const definitions = service.getDefinitionAtPosition(fileName, offset)
					if (!definitions || definitions.length === 0) continue

					// Filter out self-references (symbols defined on this same line)
					const nonSelfDefs = definitions.filter((def) => {
						if (def.fileName !== fileName) return true
						const defLine = offsetToLineCol(sourceFile, ts, def.textSpan.start)
						return defLine.line !== args.line
					})

					if (nonSelfDefs.length === 0) continue

					results.push({
						symbol: symbolName,
						definitions: nonSelfDefs.map((def) => {
							const defSourceFile = program.getSourceFile(def.fileName)
							const loc = defSourceFile
								? offsetToLineCol(defSourceFile, ts, def.textSpan.start)
								: { line: 0, column: 0 }
							return {
								file: def.fileName,
								line: loc.line,
								column: loc.column,
								kind: def.kind,
								name: def.name,
								containerName: def.containerName || undefined,
							}
						}),
					})
				}

				if (results.length === 0) {
					return {
						found: false,
						file: args.file,
						line: args.line,
						message:
							"Identifiers found on this line but none resolved to external definitions.",
					}
				}

				return {
					found: true,
					query: { file: args.file, line: args.line },
					tsconfig: tsconfigPath,
					results,
				}
			},
		})
	},
}

export default plugin
export { plugin }
