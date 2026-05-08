import { createRequire } from "node:module"
import { resolve, dirname, join } from "node:path"
import { existsSync } from "node:fs"

type TS = typeof import("typescript")

interface LanguageServiceCache {
	tsconfigPath: string
	service: ReturnType<TS["createLanguageService"]>
	ts: TS
}

let cache: LanguageServiceCache | undefined

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

// Resolve typescript from the target project's node_modules at runtime
// so this plugin works without bundling TS as a dependency.
function loadTypeScript(projectDir: string): TS {
	const req = createRequire(resolve(projectDir, "package.json"))
	const tsPath = req.resolve("typescript")
	return req(tsPath) as TS
}

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

function offsetToLineCol(sourceFile: import("typescript").SourceFile, ts: TS, offset: number) {
	const lc = ts.getLineAndCharacterOfPosition(sourceFile, offset)
	return { line: lc.line + 1, column: lc.character + 1 }
}

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

					if (seen.has(symbolName)) continue
					seen.add(symbolName)

					const definitions = service.getDefinitionAtPosition(fileName, offset)
					if (!definitions || definitions.length === 0) continue

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
