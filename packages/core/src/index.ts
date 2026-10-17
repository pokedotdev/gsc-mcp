import { Layer } from "effect"
import { GoogleAuth } from "./GoogleAuth.ts"
import { GoogleOAuth } from "./GoogleOAuth.ts"
import { GscClient } from "./GscClient.ts"
import { SearchData } from "./SearchData.ts"
import { SiteResolver } from "./SiteResolver.ts"

export * from "./AccountStore.ts"
export * from "./Aggregate.ts"
export * from "./Analysis.ts"
export * from "./DateRange.ts"
export * from "./Domain.ts"
export * from "./Errors.ts"
export * from "./Exporter.ts"
export * from "./Format.ts"
export * from "./GoogleAuth.ts"
export * from "./GoogleOAuth.ts"
export * from "./GscClient.ts"
export * from "./Progress.ts"
export * from "./ResultCache.ts"
export * from "./SearchData.ts"
export * from "./SiteResolver.ts"
export * from "./Tools.ts"

/** All core services. Requires an AccountStore, ResultCache, OAuthClientConfig and HttpClient. */
export const GscLive = Layer.mergeAll(SiteResolver.layer, SearchData.layer).pipe(
  Layer.provideMerge(GscClient.layer),
  Layer.provideMerge(GoogleAuth.layer),
  Layer.provideMerge(GoogleOAuth.layer)
)
