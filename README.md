# Seu Doutor — plataforma de busca e agendamento médico (MVP)

Aplicativo web instalável (PWA) para pacientes e painéis para médicos, clínicas, secretárias e administração. Especificação: `BRIEFING_APP_MEDICOS_CLAUDE_CODE.md` (v1.0, 29/09/2026).

> **Estado: MVP funcional com dados sintéticos. NÃO está pronto para produção.** Há bloqueios jurídicos, comerciais e operacionais listados em `docs/backlog.md` e `docs/legal-decisions.md`. Todos os documentos legais são **minutas pendentes de revisão jurídica**.

## Rodar localmente

Requisitos: Node ≥ 22, PostgreSQL ≥ 16 (com `btree_gist`, `pgcrypto`, `citext`).

```bash
npm ci
createdb seudoutor_dev seudoutor_test      # ajuste usuário/senha em DATABASE_URL
cp .env.example .env.local                  # edite; nada de segredos no git
npm run db:migrate                          # migra banco vazio (também roda nos testes)
npm run db:seed                             # dados SINTÉTICOS (recusa NODE_ENV=production)
npm run dev                                 # http://localhost:3000
npm run worker                              # outro terminal: outbox, lembretes, exportações, faxina de reservas
```

Contas do seed (todas fictícias, senha `Senha-Seed-123!`; MFA com segredo fixo impresso pelo seed):
`medica.seed@example.test` (gestora+médica), `admin.seed@example.test` (moderação/admin/segurança/suporte), `paciente.seed@example.test`.
E-mails de desenvolvimento ficam em `dev_mailbox` (nenhum e-mail real é enviado). O "PSP sandbox" está em `/sandbox-psp/<ref>` (só fora de produção).

## Comandos

| Comando | O que faz |
|---|---|
| `npm run typecheck` / `npm run lint` | tsc / eslint |
| `npm test` | 75+ testes contra PostgreSQL real (banco `seudoutor_test` é recriado a cada execução → valida migração em banco vazio) |
| `npm run test:e2e` | Playwright + axe (usa `next dev` na porta 3100 e o banco de desenvolvimento semeado) |
| `npm run bench` | carga sintética (busca e confirmação) — ver `docs/runbook.md` |
| `npm run audit:deps` / `audit:secrets` | `npm audit` / varredura básica de segredos |
| `npm run build` | build de produção |

## Mapa do repositório

```
db/migrations/      SQL versionado (0001 fundação … 0006 exportações)
src/server/modules/ regras de negócio (identity, authz, orgs, credentialing, catalog, availability, search, booking, notifications, billing, privacy, quality, reports, incidents, flags)
src/app/api/v1/     API HTTP (Route Handlers)         src/app/(páginas)  telas
tests/              suíte crítica (Vitest, banco real) e2e/  jornada em navegador
docs/               arquitetura, modelo de dados, permissões, decisões jurídicas, privacidade, riscos, backlog, runbook, API, manual admin
docs/legal/         MINUTAS dos documentos (revisão jurídica pendente)
```

## O que existe × o que está desligado

Implementado e testado: cadastro/verificação, MFA TOTP, organizações/convites/equipe/escopos, credenciamento manual, perfil e busca públicos, agenda com ocupação global, reserva temporária, agendamento/reagendamento/cancelamento/presença, lembretes por e-mail (adaptador de dev), assinatura SaaS (sandbox + webhook), privacidade do titular, feedback privado, métricas, exportações, incidentes, auditoria.

**Desligados por design (falha fechada, API responde 403):** avaliações públicas, dependentes/menores, pagamento de consultas, pontos/cashback/carteira, telemedicina, exames, prontuário/receita/atestado, destaque patrocinado. **Não implementados:** WhatsApp (sem credenciais/templates), PSP real, SMTP real, geocodificação, upload de documentos de credenciamento, apps nativos.

Documentos: [`docs/architecture.md`](docs/architecture.md) · [`docs/data-model.md`](docs/data-model.md) · [`docs/permissions.md`](docs/permissions.md) · [`docs/legal-decisions.md`](docs/legal-decisions.md) · [`docs/privacy-inventory.md`](docs/privacy-inventory.md) · [`docs/risk-register.md`](docs/risk-register.md) · [`docs/backlog.md`](docs/backlog.md) · [`docs/runbook.md`](docs/runbook.md) · [`docs/api.md`](docs/api.md) · [`docs/admin-manual.md`](docs/admin-manual.md) · [`docs/test-report.md`](docs/test-report.md)
