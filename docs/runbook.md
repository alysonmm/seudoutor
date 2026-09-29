# Runbook: ambientes, deploy, rollback, backup, carga

> Procedimentos escritos a partir do código. **Nenhum deste conjunto foi exercitado em infraestrutura de produção** (não há hospedagem contratada). Onde diz "testado", refere-se ao ambiente local descrito em `docs/test-report.md`.

## Ambientes

Desenvolvimento, homologação e produção **separados**, com dados sintéticos fora de produção. Nenhuma cópia de dados de produção para dev/homolog. `NODE_ENV=production` ativa falha fechada: segredos obrigatórios, sem `dev_mailbox`, sem PSP sandbox, cadastro exige documentos **publicados**, sandbox-psp 404.

Variáveis (ver `.env.example`): `DATABASE_URL`, `APP_ENCRYPTION_KEY` (32+ bytes aleatórios), `APP_LINK_SECRET`, `PSP_WEBHOOK_SECRET`, `APP_BASE_URL`, `EMAIL_MODE`, `PSP_MODE`, `WHATSAPP_MODE`. Segredos vêm do gerenciador do provedor de hospedagem, nunca do repositório; rotação: trocar `APP_LINK_SECRET` invalida links/códigos pendentes; trocar `APP_ENCRYPTION_KEY` exige recifrar `mfa_methods.secret_enc` (script não incluído — **pendente**).

## Deploy

1. `npm ci && npm run typecheck && npm run lint && npm test && npm audit --omit=dev` no CI.
2. Backup lógico antes de migrar (`pg_dump -Fc`).
3. `npm run db:migrate` (transacional por arquivo; checksum impede alterar migração já aplicada).
4. `npm run build && npm start`; iniciar `npm run worker` como processo separado (1+ instâncias: usa `SKIP LOCKED`).
5. Conferir `/planos` e um agendamento sintético em homologação.

## Rollback

Migrações são apenas "para frente". Rollback de código: reimplantar a versão anterior (compatível enquanto a migração nova for aditiva — regra do projeto: migrações destrutivas em duas fases). Rollback de dados: restaurar backup + reaplicar exclusões de titulares registradas em `privacy_requests`/`audit_events` (eliminações executadas **devem** ser reaplicadas após qualquer restauração).

## Backup e restauração (metas propostas: RPO ≤ 1 h, RTO ≤ 4 h — não validadas)

- Backup criptografado + WAL/PITR conforme o provedor de PostgreSQL contratado.
- Teste de restauração em ambiente isolado (AC20): restaurar, `npm run db:migrate`, rodar `npm test` contra a cópia, **medir** o tempo, reaplicar exclusões, registrar resultado. **Ainda não executado** — depende de infraestrutura.

## Monitoramento (a implantar)

Alertas com responsável e procedimento para: erros 5xx, atraso da fila (`outbox_events` sem `processed_at` > 5 min; `notification_jobs` pendentes vencidos), falhas de e-mail (`status='dead'`), `slot_conflict` anômalo, webhooks rejeitados (`provider_events.result`), fila de credenciamento e incidentes com `overdue`. Logs não contêm senha, token, texto clínico; erros 500 saem sem payload.

## Indisponibilidade

Nunca declarar consulta confirmada se o banco falhou: a confirmação só é apresentada após resposta 201 da transação; em falha de rede a interface diz que nada foi confirmado e orienta a conferir "Meus agendamentos". Comunicar por canal alternativo e reconciliar depois (consultas criadas manualmente pela recepção).

## Carga sintética

`npm run bench` (ver `scripts/bench.ts`) executa 100 usuários concorrentes contra o banco de teste local: busca e confirmação, excluindo integrações externas. Resultados e limitações em `docs/test-report.md`. São metas a **medir**, não promessa de capacidade.

## Incidentes

identificar → conter → preservar evidências mínimas → avaliar titulares/riscos → acionar jurídico/privacidade → comunicar quando cabível → corrigir → registrar lições. Use `/admin/incidentes` (relógio de 3 dias úteis a partir da ciência de afetação de dados pessoais; referência J8, feriados não considerados). Meta contratual proposta: fornecedor avisa em até 24 h. Modelos de comunicação e substituto do responsável: **a definir**.
