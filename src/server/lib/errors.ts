export class AppError extends Error {
  constructor(public status: number, public code: string, message?: string, public details?: unknown) {
    super(message ?? code);
  }
}
export const badRequest = (code = 'bad_request', msg?: string, d?: unknown) => new AppError(400, code, msg, d);
export const unauthorized = (code = 'unauthenticated', msg = 'Autenticação necessária') => new AppError(401, code, msg);
export const forbidden = (code = 'forbidden', msg = 'Sem permissão') => new AppError(403, code, msg);
export const notFound = (code = 'not_found', msg = 'Não encontrado') => new AppError(404, code, msg);
export const conflict = (code = 'conflict', msg?: string, d?: unknown) => new AppError(409, code, msg, d);
export const tooMany = (msg = 'Muitas tentativas. Tente novamente em instantes.') => new AppError(429, 'rate_limited', msg);
export const unavailable = (code = 'unavailable', msg = 'Recurso indisponível') => new AppError(503, code, msg);
