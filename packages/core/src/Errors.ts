import { Schema } from "effect"

// Every error carries a human readable `message`: the MCP server forwards it
// verbatim to the agent, so it should explain how to recover.

export class AccountNotFound extends Schema.TaggedError<AccountNotFound>()("AccountNotFound", {
  alias: Schema.String,
  message: Schema.String
}) {}

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  account: Schema.String,
  message: Schema.String
}) {}

export class AccountStoreError extends Schema.TaggedError<AccountStoreError>()("AccountStoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export class SiteNotFound extends Schema.TaggedError<SiteNotFound>()("SiteNotFound", {
  site: Schema.String,
  message: Schema.String
}) {}

export class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()("QuotaExceeded", {
  account: Schema.String,
  message: Schema.String
}) {}

export class GscApiError extends Schema.TaggedError<GscApiError>()("GscApiError", {
  status: Schema.optional(Schema.Number),
  message: Schema.String
}) {}

export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  message: Schema.String
}) {}

export const GscError = Schema.Union([
  AccountNotFound,
  AuthError,
  AccountStoreError,
  SiteNotFound,
  QuotaExceeded,
  GscApiError,
  InvalidInput
])
export type GscError = typeof GscError.Type
