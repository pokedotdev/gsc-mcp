import { Context, Effect, Layer, Option } from "effect"
import { McpSchema, McpServer } from "effect/ai"

/**
 * Reports progress of long-running work to whoever started it. Does nothing
 * by default, so services can report unconditionally.
 */
export const Progress = Context.Reference<{
  report(progress: number, total: number | undefined, message: string): Effect.Effect<void>
}>("gsc-mcp/Progress", {
  defaultValue: () => ({ report: () => Effect.void })
})

/** Sends progress as MCP notifications to clients that asked for them with a progress token. */
export const ProgressMcp = Layer.effect(
  Progress,
  Effect.gen(function*() {
    const server = yield* McpServer.McpServer
    return {
      report: (progress: number, total: number | undefined, message: string) =>
        Effect.serviceOption(McpSchema.McpRequestContext).pipe(
          Effect.flatMap((context) => {
            const token = Option.getOrUndefined(context)?.requestMetadata?.["progressToken"]
            if (typeof token !== "string" && typeof token !== "number") return Effect.void
            return server.notifications["notifications/progress"]({
              progressToken: token,
              progress,
              ...(total === undefined ? {} : { total }),
              message
            })
          }),
          Effect.ignore
        )
    }
  })
)
