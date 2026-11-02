export type ContractGuardErrorCode =
  | "PARSE_ERROR"
  | "INVALID_DOCUMENT"
  | "UNSUPPORTED_SPEC_VERSION"
  | "INVALID_REFERENCE"
  | "EXTERNAL_REFERENCE_UNSUPPORTED"
  | "INVALID_POLICY"
  | "INVALID_CONSUMER_EVIDENCE"
  | "INVALID_REGRESSION_PACK"
  | "INVALID_BUNDLE"
  | "BUNDLE_LIMIT_EXCEEDED";

export class ContractGuardError extends Error {
  readonly code: ContractGuardErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ContractGuardErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ContractGuardError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
