import type { ProviderId, ProviderStatus } from "./types.js";

export type HarnessSdkErrorCode =
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_NOT_AUTHENTICATED"
  | "PROVIDER_RUN_FAILED"
  | "INVALID_REQUEST";

export class HarnessSdkError extends Error {
  readonly code: HarnessSdkErrorCode;
  readonly provider?: ProviderId;
  readonly statuses?: ProviderStatus[];

  constructor(
    code: HarnessSdkErrorCode,
    message: string,
    options: { provider?: ProviderId; statuses?: ProviderStatus[] } = {}
  ) {
    super(message);
    this.name = "HarnessSdkError";
    this.code = code;
    this.provider = options.provider;
    this.statuses = options.statuses;
  }
}
