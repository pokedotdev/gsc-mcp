import { Layer } from "effect"
import { GoogleAuth } from "./GoogleAuth.ts"
import { GoogleOAuth } from "./GoogleOAuth.ts"
import { GscClient } from "./GscClient.ts"
import { SiteResolver } from "./SiteResolver.ts"

export * from "./AccountStore.ts"
export * from "./DateRange.ts"
export * from "./Domain.ts"
export * from "./Errors.ts"
export * from "./GoogleAuth.ts"
export * from "./GoogleOAuth.ts"
export * from "./GscClient.ts"
export * from "./SiteResolver.ts"
export * from "./Tools.ts"

/** All core services. Requires an AccountStore, OAuthClientConfig and HttpClient. */
export const GscLive = SiteResolver.layer.pipe(
  Layer.provideMerge(GscClient.layer),
  Layer.provideMerge(GoogleAuth.layer),
  Layer.provideMerge(GoogleOAuth.layer)
)
