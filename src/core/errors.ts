// Exit-code contract (docs/m1-plan.md, Conventions):
//   0 ok · 1 refused / check failed · 2 usage or config error · 3 internal error
// Every non-zero exit prints exactly one stderr line naming the reason.

export const EXIT = { ok: 0, refused: 1, usage: 2, internal: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class RadrError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A gate, fingerprint, drift, or policy check said no. */
export class RefusedError extends RadrError {
  constructor(message: string) {
    super(message, EXIT.refused);
  }
}

/** Bad arguments, missing or invalid config. */
export class UsageError extends RadrError {
  constructor(message: string) {
    super(message, EXIT.usage);
  }
}

/** A bug or an unexpected environment failure. */
export class InternalError extends RadrError {
  constructor(message: string) {
    super(message, EXIT.internal);
  }
}
