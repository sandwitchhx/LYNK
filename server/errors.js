export class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_ERROR') { super(message); this.status = status; this.code = code; }
}
export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
export function requireFields(body, fields) {
  for (const field of fields) {
    if (typeof body[field] !== 'string' || !body[field].trim()) throw new HttpError(400, `${field} is required.`, 'VALIDATION_ERROR');
  }
}
