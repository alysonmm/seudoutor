# API `/api/v1` (resumo)

JSON, UTF-8. Erros: `{ "error": { "code", "message", "details?" } }` com `400` validação, `401` sem sessão, `403` sem permissão/MFA/recurso desligado, `404` (inclusive fora do escopo), `409` conflito, `422` chave de idempotência reutilizada, `429` limite, `503` integração/documento indisponível (falha fechada). Erros 500 trazem só `requestId`.

Autenticação: cookie de sessão `sid` (HttpOnly). Mutações verificam `Origin`/`Sec-Fetch-Site` (CSRF). Mutações críticas aceitam `Idempotency-Key`. **Nenhuma resposta traz dados de terceiros.** Não há OpenAPI gerado ainda (pendência menor no backlog); esta tabela é a referência e cada rota tem teste.

## Público
| Método e rota | Descrição |
|---|---|
| `GET /practitioners?q&specialty&city&neighborhood&insuranceProductId&private&maxPriceCents&date&timeFrom&timeTo&patientAge&accessibility&language&lat&lng&maxKm&sort&page` | Busca (somente perfis aprovados e agendáveis; sem avaliações) |
| `GET /practitioners/{slug}` | Perfil, ofertas por local, preço (ou "não informado"), convênios+produto |
| `GET /availability?offeringId&from&to` | Horários livres (livre/ocupado apenas, máx. 92 dias) |
| `GET /reference` · `GET /plans` · `GET /legal/{key}` | Especialidades/convênios · planos (hipóteses) · documento vigente (minuta marcada) |

## Paciente (sessão)
| Rota | Descrição |
|---|---|
| `POST /auth/register` `verify-email` `login` `logout` · `POST /auth/password-reset/{request,confirm}` · `POST /auth/mfa/{enroll,confirm,verify}` · `GET /auth/me` · `PATCH /me` | Conta |
| `POST /slot-holds` · `DELETE /slot-holds/{id}` | Reserva de 5 min |
| `POST /appointments` `{holdId | offeringId+startsAt, payerType, insuranceProductId?, expectedPriceCents?}` | Confirma (revalida tudo) |
| `GET /me/appointments` · `GET /me/appointments/{id}` | Meus agendamentos (snapshot preservado) |
| `POST /appointments/{id}/{confirm,reschedule,cancel,contest}` | Presença, reagendar (atômico), cancelar (idempotente), contestar falta |
| `POST /me/appointments/{id}/feedback` | Feedback privado (consulta concluída) |
| `GET/POST /me/privacy-requests` · `GET /me/export` · `GET/PUT /me/consents` · `POST /me/tickets` | Privacidade e suporte |
| `GET /links/{token}` (informa) · `POST /links/act` (executa) | Ações de e-mail assinadas |

## Organização (`/organizations/{orgId}/…`, exige vínculo e permissão)
`locations`, `services`, `offerings`, `offerings/{id}/insurance`, `availability/{rules,exceptions,blocks}`, `appointments` (GET lista/POST manual), `practitioners/{pid}/{identity,submit,public}`, `members`, `invitations`, `members/{id}` (DELETE), `members/{id}/scopes`, `subscription` (GET/POST/DELETE), `subscription/refund-requests`, `metrics`, `feedback-summary`, `exports` (POST) e `exports/{id}` (GET CSV). `POST /appointments/{id}/{check-in,complete,no-show,approve,deny}` para a equipe. `POST /organizations` cria organização; `POST /invitations/accept`.

## Administração (papéis de plataforma)
`GET /admin/credentialing`, `POST /admin/credentialing/{versionId}/review`, `POST /admin/practitioners/{id}/{suspend,reinstate}`, `GET /admin/metrics`, `GET /admin/privacy-requests`, `POST …/{id}/resolve|erase`, `GET/POST /admin/incidents`, `PATCH /admin/incidents/{id}`, `GET /admin/audit`, `GET /admin/flags`.

## Webhook
`POST /webhooks/psp` — cabeçalhos `x-psp-timestamp` (epoch s, ±5 min) e `x-psp-signature` (= HMAC-SHA256 hex de `"{timestamp}.{corpo bruto}"` com `PSP_WEBHOOK_SECRET`). Eventos: `payment.succeeded`, `payment.failed`, `subscription.renewed`, `payment.refunded` (`id`, `createdAt`, `data.{subscriptionRef,paymentRef,amountCents,currency,periodStart?,periodEnd?}`). Formato definido pelo projeto para o sandbox; o PSP real exigirá adaptação.

## Módulos bloqueados
`/loyalty`, `/clinical-payments`, `/telehealth`, `/dependents`, `/exams`, `/public-reviews`, `/clinical-records` → `403 feature_disabled` (mesmo habilitados em banco: `501`).

## Eventos (outbox, `event_version` 1, payload mínimo)
`AppointmentScheduled`, `AppointmentRescheduled`, `AppointmentCancelled`, `AttendanceConfirmed`, `PractitionerSuspended`, `SubscriptionActivated`, `SubscriptionPastDue`, `PrivacyRequestCreated`. Eventos sem consumidor no MVP (ex.: `AttendanceConfirmed`, `SubscriptionActivated`) apenas ficam registrados e marcados como processados.
