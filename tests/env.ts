process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://seudoutor:seudoutor@localhost:5432/seudoutor_test';
(process.env as any).NODE_ENV = 'test';
process.env.EMAIL_MODE = 'dev';
process.env.PSP_MODE = 'sandbox';
process.env.PSP_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.APP_BASE_URL = 'http://localhost:3000';
// Pool pequeno de propósito: qualquer código que peça 2ª conexão dentro de transação trava (regressão de deadlock sob carga).
process.env.DB_POOL_MAX = '5';
