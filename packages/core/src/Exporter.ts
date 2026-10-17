import { Context, Effect, Layer } from "effect"
import type { ExportError } from "./Errors.ts"
import { InvalidInput } from "./Errors.ts"

export interface ExportedFile {
  readonly path: string
  readonly bytes: number
}

/**
 * Writes large results to files that agents process with their own tools
 * (jq, awk, DuckDB...) instead of reading them into their context. Only
 * available where the server shares a filesystem with the agent.
 */
export class Exporter extends Context.Service<Exporter, {
  write(options: {
    /** File name without directory, e.g. "search_analytics-example.com-2026-01-01.csv". */
    readonly name: string
    readonly content: string
  }): Effect.Effect<ExportedFile, ExportError | InvalidInput>
}>()("gsc-mcp/Exporter") {
  static readonly layerUnsupported = Layer.succeed(Exporter)(Exporter.of({
    write: () =>
      Effect.fail(
        new InvalidInput({
          message: "This server cannot write files. Use output: \"inline\" and reduce the rows with the aggregate tool."
        })
      )
  }))
}

/** File-name friendly version of a property: "sc-domain:example.com" -> "example.com". */
export const fileSlug = (text: string) =>
  text.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9.-]+/g, "_").replace(/^_+|_+$/g, "")
