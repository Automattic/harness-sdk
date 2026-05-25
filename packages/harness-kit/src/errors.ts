import type { ProviderId, ProviderStatus } from "./types.js";

export type HarnessKitErrorCode =
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_NOT_AUTHENTICATED"
  | "PROVIDER_RUN_FAILED"
  | "INVALID_REQUEST";

export class HarnessKitError extends Error {
  readonly code: HarnessKitErrorCode;
  readonly provider?: ProviderId;
  readonly statuses?: ProviderStatus[];

  constructor(
    code: HarnessKitErrorCode,
    message: string,
    options: { provider?: ProviderId; statuses?: ProviderStatus[] } = {}
  ) {
    super(message);
    this.name = "HarnessKitError";
    this.code = code;
    this.provider = options.provider;
    this.statuses = options.statuses;
  }
}
