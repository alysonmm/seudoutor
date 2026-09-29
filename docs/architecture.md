# Arquitetura e decisões técnicas

Versão do briefing: 1.0 (29/09/2026). Este documento registra o que **foi implementado** e as decisões tomadas. Ele não é parecer jurídico.

## Stack e versões (fixadas em `package-lock.json`)

| Camada | Escolha | Observação |
|---|---|---|
| Linguagem | TypeScript 5.9 | `strict` |
| Web | Next.js 16.3 (App Router) + React 19 | Route Handlers formam a API `/api/v1`; Server Components chamam os módulos diretamente |
| Banco | PostgreSQL 16 | `btree_gist` (exclusão de intervalos), `pgcrypto`, `citext` |
| Acesso a dados | `pg` + SQL versionado (`db/migrations`) | Sem ORM: as garantias críticas são constraints SQL |
| Validação | Zod 4 | |
| Datas/fusos | Luxon | fuso IANA por local; UTC no banco |
| MFA | otplib 13 (TOTP) | segredo cifrado AES-256-GCM (Node `crypto`) |
| Testes | Vitest (banco real), Playwright + axe | |

Decisões: monólito modular (`src/server/modules/*`), sem Redis/fila externa (a fila é o próprio PostgreSQL: `outbox_events` + `notification_jobs` com `FOR UPDATE SKIP LOCKED`); sem PostGIS (distância por Haversine, rotulada "linha reta, aproximada"; PostGIS entra quando houver volume que exija). Busca em SQL puro (sem motor externo).

## Módulos

`identity` (cadastro, sessão, MFA) · `authz` (RBAC + escopo) · `orgs` (organizações, convites, equipe) · `credentialing` · `catalog` (locais/serviços/convênios) · `availability` (grade, exceções, bloqueios, cálculo de horários) · `search` · `booking` (reserva, agendamento, reagendamento, cancelamento, presença) · `notifications` (outbox + jobs) · `billing` (assinatura SaaS, webhook) · `entitlements` · `privacy` · `quality` (feedback privado) · `reports` (métricas, exportações) · `incidents` (+ auditoria) · `flags` · `documents`.

## Agenda: como o conflito é impedido

1. `practitioner_occupancies` guarda, **por profissional global**, o intervalo ocupado (`tstzrange`) — sem paciente, sem organização.
2. `EXCLUDE USING gist (practitioner_id WITH =, during WITH &&)` impede sobreposição no banco, entre organizações e locais diferentes.
3. Intervalo = consulta + preparo + intervalo posterior + deslocamento (`travel_buffer_minutes`, conservador, aplicado dos dois lados).
4. Reserva temporária (`hold`, 5 min) é uma ocupação com `expires_at`. Vencimento é **lógico**: o cálculo de horários ignora holds vencidos e cada reserva/agendamento apaga os vencidos do profissional dentro da própria transação; o worker apenas faz faxina.
5. Confirmação revalida grade (regras/exceções/bloqueios/antecedência/horizonte), assinatura, aprovação do profissional e preço esperado.
6. Reagendamento: libera a ocupação antiga e cria a nova na **mesma transação**; falha no destino reverte tudo (original preservado).
7. Idempotência: `Idempotency-Key` + `pg_advisory_xact_lock` por (usuário, operação, chave).
8. Encaixe: não existe bypass; só ocupa intervalo livre.

Mudanças de regra/exceção/bloqueio que afetam consultas existentes são **recusadas com a lista de impactadas** (409); só passam com reconhecimento explícito dos IDs, e as consultas ficam preservadas e sinalizadas (`needs_followup`).

## Ordenação da busca (documentada)

Filtros são restritivos. Ordenação escolhida pelo usuário: `next_slot` (padrão), `distance` ou `price`. Desempate estável: nome de exibição (pt-BR) e depois `practitioner_id+location_id`. **Nenhum peso por plano/assinatura.** Sem "melhor médico", sem avaliações públicas, sem destaque patrocinado. Preço desconhecido (`NULL`) não é R$ 0 e não casa com filtro de preço.

## "Agendável" — regra única (`BOOKABLE_SQL`)

Médico `approved` com versão de identidade aprovada + vínculo ativo + organização ativa + **assinatura/teste vigente** + local e oferta ativos. Usada em busca, perfil, disponibilidade e reserva. Suspenso/pendente/sem assinatura → bloqueado no servidor.

## Assinatura SaaS

- Planos versionados (`plan_versions`); cada assinatura guarda versão e valor contratados.
- Estados: `pending` (extensão ao briefing: contratação aguardando pagamento), `trialing`, `active`, `grace_period`, `past_due`, `cancel_at_period_end`, `cancelled`, `expired`.
- Semântica adotada (**a validar comercialmente**): falha de pagamento → `grace_period` (carência, acesso pleno) → `past_due` (sem novas marcações públicas/novos recursos; consultas existentes, painel e exportação seguem) . Teste vencido → `expired` (exige contratação expressa).
- Ativação **somente por webhook**: HMAC-SHA256 de `timestamp.corpo`, tolerância de 5 min (replay), idempotência por `(provider,event_id)`, conferência de valor/moeda, descarte de eventos fora de ordem, fatura única por período.
- PSP: só há adaptador **sandbox** (recusado em produção). Sem PSP contratado, o checkout responde 503 `psp_not_configured`.
- Recibo operacional (`REC-…`) não é nota fiscal.

## Comunicação

Outbox transacional → `processOutbox` cria `notification_jobs` (dedupe por chave) → `processDueJobs` **revalida o estado da consulta imediatamente antes de enviar** (AC09). Lembretes 24h/3h, nunca criados se já vencidos. Texto discreto ("Você tem um agendamento. Consulte os detalhes no app"). Links de ação são assinados (HMAC), com finalidade única e curta duração; **GET só informa, POST executa** (AC16). E-mail: adaptador de desenvolvimento (`dev_mailbox`); qualquer outro modo falha ("não simula sucesso"). WhatsApp: **não implementado** (flag desligada, sem credenciais/templates aprovados).

## Segurança (resumo; detalhes em `docs/permissions.md`)

scrypt (N=2^15) para senhas; sessões opacas com hash no banco, cookie HttpOnly/SameSite=Lax/Secure em produção; CSRF por verificação de origem; rate limit no banco; MFA obrigatório a qualquer papel profissional/plataforma (sessão sem 2º fator é barrada em `requireAuth`); anti-enumeração no cadastro e recuperação; autorização consultada no banco a cada requisição (remoção de membro vale de imediato e revoga sessões); auditoria append-only por trigger; cabeçalhos de segurança e `no-store` em áreas autenticadas; PWA sem cache de dados privados.

## Métricas (dicionário)

- Ocupação = minutos agendados ÷ minutos disponibilizados (regras/exceções, descontados bloqueios).
- Falta = `no_show` ÷ (`completed` + `no_show`); consultas futuras não entram.
- Novo paciente = primeira consulta **concluída** do paciente na organização, dentro do período.
- MRR = recorrência normalizada (anual ÷ 12) de assinaturas pagantes; teste gratuito e valor das consultas dos médicos não entram.
- Período e fuso sempre informados; grupos pequenos (`< small_group_suppression_min`) suprimidos.

## Feature flags

Falha fechada: `enabled ∧ implemented ∧ (¬regulated ∨ aprovação humana vigente)`. Constraint no banco impede `enabled` regulado sem aprovação. Nenhum módulo bloqueado tem implementação; as rotas respondem 403 (`feature_disabled`) — e 501 mesmo se alguém as ligasse.

## Ambientes e deploy

Ver `docs/runbook.md`.
