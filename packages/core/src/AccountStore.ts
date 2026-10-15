import { Context, Effect, Layer, Ref } from "effect"
import type { Account } from "./Domain.ts"
import { AccountNotFound, type AccountStoreError } from "./Errors.ts"

/** Persistence for authorized Google accounts. Implemented per runtime. */
export class AccountStore extends Context.Service<AccountStore, {
  readonly list: Effect.Effect<ReadonlyArray<Account>, AccountStoreError>
  get(alias: string): Effect.Effect<Account, AccountNotFound | AccountStoreError>
  upsert(account: Account): Effect.Effect<void, AccountStoreError>
  remove(alias: string): Effect.Effect<void, AccountNotFound | AccountStoreError>
}>()("gsc-mcp/AccountStore") {
  /** In-memory store, used by tests. */
  static readonly layerMemory = (initial: ReadonlyArray<Account> = []) =>
    Layer.effect(
      AccountStore,
      Effect.gen(function*() {
        const ref = yield* Ref.make<ReadonlyArray<Account>>(initial)
        const list = Ref.get(ref)
        return AccountStore.of({
          list,
          get: (alias) =>
            Effect.flatMap(list, (accounts) => {
              const account = accounts.find((a) => a.alias === alias)
              return account ? Effect.succeed(account) : Effect.fail(accountNotFound(alias, accounts))
            }),
          upsert: (account) => Ref.update(ref, (accounts) => [...accounts.filter((a) => a.alias !== account.alias), account]),
          remove: (alias) =>
            Effect.flatMap(list, (accounts) =>
              accounts.some((a) => a.alias === alias)
                ? Ref.set(ref, accounts.filter((a) => a.alias !== alias))
                : Effect.fail(accountNotFound(alias, accounts)))
        })
      })
    )
}

export const accountNotFound = (alias: string, accounts: ReadonlyArray<Account>) =>
  new AccountNotFound({
    alias,
    message: accounts.length === 0
      ? `Account "${alias}" not found. No accounts are configured yet: run \`gsc-mcp auth add <alias>\`.`
      : `Account "${alias}" not found. Available accounts: ${accounts.map((a) => a.alias).join(", ")}.`
  })
