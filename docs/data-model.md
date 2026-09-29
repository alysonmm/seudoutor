# Modelo de dados

Fonte da verdade: `db/migrations/*.sql`. IDs `uuid` opacos; dinheiro em centavos inteiros + moeda; `timestamptz` em UTC + fuso IANA por local/consulta. Nenhum `ON DELETE CASCADE` indiscriminado (não há cascade); vínculos históricos são mantidos com status.

| Grupo | Tabelas | Notas |
|---|---|---|
| Identidade | `users`, `sessions` (hash sha256), `contact_verifications`, `mfa_methods` (segredo AES-GCM), `mfa_recovery_codes`, `rate_limits`, `invitations` | e-mail `citext` único |
| Organizações/RBAC | `organizations`, `roles`, `permissions`, `role_permissions`, `memberships` (único por usuário+org+papel), `member_scopes`, `platform_staff`, `support_access_grants` | remoção = `status='removed'` |
| Profissionais | `practitioners` (identidade global), `professional_registrations` (**UNIQUE CRM+UF+número**), `specialties`, `practitioner_specialties` (RQE), `public_profile_versions` (snapshots revisados), `credential_checks` (evidência), `practitioner_memberships` | publicação só via `current_public_version_id` |
| Locais/serviços | `locations`, `services`, `practitioner_services` (oferta: médico+local+serviço, preço `NULL` = não informado), `insurers`, `insurance_products`, `accepted_insurance_products` | **FKs compostas** `(id, organization_id)` impedem relacionamento entre organizações |
| Pacientes | `patient_accounts`, `organization_patients` (registro local), `patient_account_links` (só após verificação), `patient_link_invitations`, `notification_preferences` | sem CPF |
| Agenda | `availability_rules`, `availability_exceptions`, `schedule_blocks`, `slot_holds`, **`practitioner_occupancies`** (EXCLUDE gist global), `appointments`, `appointment_events`, `idempotency_keys` | `appointments` liga profissional↔organização, serviço↔local↔profissional e paciente↔organização por FKs compostas; CHECKs: status ativo exige ocupação; conclusão/falta exige `scheduled` |
| Comunicação | `outbox_events`, `notification_templates`, `notification_jobs` (dedupe), `delivery_events`, `dev_mailbox` (só dev) | |
| SaaS | `subscription_plans`, `plan_versions`, `subscriptions` (uma viva por organização), `billing_invoices` (única por período), `billing_payments`, `provider_events` (única por provedor+evento), `checkout_sessions`, `usage_counters`, `refund_requests` | `entitlements` são derivados de `plan_versions.limits` + estado (código em `entitlements.ts`), não tabela separada |
| Qualidade | `feedback` (**CHECK visibility='private'**), `reviews`* , `moderation_cases`, `reports`, `support_tickets`, `data_exports` | *`reviews` não existe ainda: publicação exige migração própria após revisão jurídica |
| Governança | `legal_documents`, `document_versions` (**CHECK: publicada exige aprovador**), `terms_acceptances` (hash, versão, contexto), `consent_events`, `privacy_requests`, `retention_policies`, `processing_activities`, `audit_events` (**append-only por trigger**), `security_incidents`, `feature_approvals`, `feature_flags` (**CHECK: regulada ligada exige aprovação**), `system_settings` | |

Diferenças em relação ao briefing (§20), com motivo: `practitioner_services` inclui o local (uma oferta = médico+local+serviço); `service_prices` e `entitlements` não são tabelas separadas (preço e limites vivem na oferta e na versão do plano); `reviews` só será criada quando o módulo for liberado; `guardianships`, `clinical_payments`, `ledger_entries`, `labs`, `exam_catalog`, `telehealth_sessions` **não foram criadas** de propósito (§20: só com migrações e escopo próprios).

Índices principais: CRM+UF (unique), slugs, `(practitioner_id, during)` gist via constraint, `organization_id+starts_at`, paciente/solicitante+data, `(provider,event_id)` único, chaves de idempotência (PK), `dedupe_key` únicos.
