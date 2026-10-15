import { Account, AccountStore, accountNotFound, AccountStoreError } from "@gsc-mcp/core"
import { Effect, FileSystem, Layer, Schema, Semaphore } from "effect"
import { ConfigDir } from "./Paths.ts"

const AccountsFile = Schema.fromJsonString(Schema.Struct({
  version: Schema.Literal(1),
  accounts: Schema.Array(Account)
}))

/** Stores accounts (including refresh tokens) in a JSON file readable only by the user. */
export const FileAccountStore = Layer.effect(
  AccountStore,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const { dir, accountsFile } = yield* ConfigDir
    const lock = yield* Semaphore.make(1)

    const storeError = (message: string) => (cause: unknown) => new AccountStoreError({ message, cause })

    const read = Effect.gen(function*() {
      if (!(yield* fs.exists(accountsFile))) return []
      const content = yield* fs.readFileString(accountsFile)
      const file = yield* Schema.decodeEffect(AccountsFile)(content)
      return file.accounts
    }).pipe(Effect.mapError(storeError(`Could not read ${accountsFile}`)))

    const write = (accounts: ReadonlyArray<Account>) =>
      Effect.gen(function*() {
        yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
        const content = yield* Schema.encodeEffect(AccountsFile)({ version: 1, accounts })
        // Write then rename, so a crash never leaves a truncated file behind.
        const tmp = `${accountsFile}.tmp`
        yield* fs.writeFileString(tmp, content, { mode: 0o600 })
        yield* fs.rename(tmp, accountsFile)
      }).pipe(Effect.mapError(storeError(`Could not write ${accountsFile}`)))

    const get = Effect.fn("FileAccountStore.get")(function*(alias: string) {
      const accounts = yield* read
      const account = accounts.find((a) => a.alias === alias)
      if (account === undefined) return yield* accountNotFound(alias, accounts)
      return account
    })

    const upsert = (account: Account) =>
      lock.withPermits(1)(Effect.gen(function*() {
        const accounts = yield* read
        yield* write([...accounts.filter((a) => a.alias !== account.alias), account])
      }))

    const remove = (alias: string) =>
      lock.withPermits(1)(Effect.gen(function*() {
        const accounts = yield* read
        if (!accounts.some((a) => a.alias === alias)) return yield* accountNotFound(alias, accounts)
        yield* write(accounts.filter((a) => a.alias !== alias))
      }))

    return AccountStore.of({ list: read, get, upsert, remove })
  })
)
