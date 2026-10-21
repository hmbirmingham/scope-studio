// Errors the CAD plug-in throws carry a stable `code`, so the runner's step
// record (`capability_error: …`) and the HTTP routes can say what went wrong
// without parsing a message.
export class CadError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}
