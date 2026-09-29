-- Etapa 4 — Operação comercial (assinatura SaaS), governança, privacidade e qualidade.

-- ---------- Documentos legais e aceites ----------
CREATE TABLE legal_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  title text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('patient','practitioner','all','internal'))
);
CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES legal_documents(id),
  version int NOT NULL,
  body_md text NOT NULL,
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'draft_minuta' CHECK (status IN ('draft_minuta','published','superseded')),
  approved_by text,                             -- nome do responsável humano; NUNCA preenchido por código
  approved_at date,
  published_at timestamptz,
  requires_reacceptance boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version),
  CHECK (status <> 'published' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE TABLE terms_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  organization_id uuid REFERENCES organizations(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  content_hash text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  context jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX terms_acceptances_user_idx ON terms_acceptances(user_id, accepted_at DESC);
-- Consentimentos opcionais (marketing, geolocalização, notificações): separados dos termos e nunca pré-marcados.
CREATE TABLE consent_events (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN ('marketing','geolocation','push','whatsapp')),
  granted boolean NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  document_version_id uuid REFERENCES document_versions(id),
  context jsonb NOT NULL DEFAULT '{}'
);

-- ---------- Assinaturas SaaS ----------
CREATE TABLE subscription_plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id text NOT NULL REFERENCES subscription_plans(id),
  version int NOT NULL,
  price_monthly_cents integer NOT NULL CHECK (price_monthly_cents >= 0),
  price_yearly_cents integer NOT NULL CHECK (price_yearly_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'BRL',
  limits jsonb NOT NULL,
  features jsonb NOT NULL DEFAULT '{}',
  is_hypothesis boolean NOT NULL DEFAULT true,  -- valores do briefing são hipóteses de teste
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version)
);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id),   -- versão contratada, imutável por assinatura
  billing_period text NOT NULL CHECK (billing_period IN ('monthly','yearly')),
  status text NOT NULL CHECK (status IN
    ('pending','trialing','active','past_due','grace_period','cancel_at_period_end','cancelled','expired')),
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  grace_ends_at timestamptz,
  cancel_requested_at timestamptz,
  cancelled_at timestamptz,
  provider text,
  provider_subscription_ref text,
  last_provider_event_at timestamptz,
  amount_cents integer NOT NULL,                 -- snapshot do valor contratado
  currency char(3) NOT NULL DEFAULT 'BRL',
  contract_acceptance_id uuid REFERENCES terms_acceptances(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscriptions_one_live_per_org ON subscriptions(organization_id)
  WHERE status NOT IN ('cancelled','expired');

CREATE TABLE billing_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  amount_cents integer NOT NULL,
  currency char(3) NOT NULL DEFAULT 'BRL',
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','failed','void')),
  provider_invoice_ref text UNIQUE,
  receipt_number text,                           -- recibo operacional (não é nota fiscal)
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, period_start)         -- renovação idempotente
);
CREATE TABLE billing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES billing_invoices(id),
  provider text NOT NULL,
  provider_payment_ref text NOT NULL,
  amount_cents integer NOT NULL,
  currency char(3) NOT NULL,
  status text NOT NULL CHECK (status IN ('paid','failed','refunded')),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_ref)
);
CREATE TABLE provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  result text,
  UNIQUE (provider, event_id)
);
CREATE TABLE checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  provider text NOT NULL,
  provider_session_ref text UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','expired')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE usage_counters (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  counter text NOT NULL,
  period text NOT NULL,                          -- ex.: 2026-09
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, counter, period)
);
CREATE TABLE refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('withdrawal','refund','other')),
  reason text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','denied')),
  decision_note text,
  decided_by uuid REFERENCES users(id),
  protocol text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

INSERT INTO subscription_plans(id, name) VALUES
 ('essencial','Essencial'),('profissional','Profissional'),('clinica','Clínica');
-- Hipóteses de preço do briefing (editáveis). Não são dado empresarial validado.
INSERT INTO plan_versions(plan_id, version, price_monthly_cents, price_yearly_cents, limits, features) VALUES
 ('essencial',1,6900,69000,'{"practitioners":1,"locations":1,"members":1,"whatsapp_monthly_quota":0}','{"reminders":["email"],"reports":false}'),
 ('profissional',1,12900,129000,'{"practitioners":1,"locations":5,"members":3,"whatsapp_monthly_quota":0}','{"reminders":["email","whatsapp"],"reports":true}'),
 ('clinica',1,24900,249000,'{"practitioners":3,"locations":3,"members":5,"whatsapp_monthly_quota":0}','{"reminders":["email","whatsapp"],"reports":true}');

-- ---------- Privacidade e governança ----------
CREATE TABLE privacy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('access','correction','portability','erasure','revocation','other')),
  details text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','fulfilled','partially_fulfilled','denied')),
  due_at timestamptz NOT NULL,
  responsible text,
  decision text,                                 -- decisão fundamentada
  retained_categories text[] NOT NULL DEFAULT '{}',
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_class text NOT NULL,
  retention text NOT NULL,
  start_event text NOT NULL,
  basis text NOT NULL,
  version int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved')),
  approved_by text,
  exceptions text,
  CHECK (status <> 'approved' OR approved_by IS NOT NULL),
  UNIQUE (data_class, version)
);
INSERT INTO retention_policies(data_class, retention, start_event, basis, exceptions) VALUES
 ('Reserva temporária expirada','curto período de diagnóstico (a definir)','expiração da reserva','PROPOSTA OPERACIONAL — não é prazo legal',NULL),
 ('Corpo de mensagens enviadas','mínimo necessário (a definir)','envio','PROPOSTA OPERACIONAL — não é prazo legal',NULL),
 ('Backups','janela definida (a definir)','criação do backup','PROPOSTA OPERACIONAL — restauração reaplica exclusões',NULL),
 ('Documentos de identidade de credenciamento','descartar após verificação quando não houver motivo de guarda','conclusão da verificação','PROPOSTA OPERACIONAL — validar com jurídico',NULL),
 ('Registros de acesso a aplicações','mapear art. 15 do Marco Civil (seis meses)','acesso','A CONFIRMAR PELO JURÍDICO — referência J7',NULL),
 ('Auditoria, incidentes (registro), cobranças, solicitações de titulares','a definir por classe','evento','A DEFINIR PELO JURÍDICO — incidentes: mínimo de 5 anos segundo J8 (confirmar)',NULL),
 ('Agenda administrativa','a definir (não herda prazo de prontuário)','conclusão/cancelamento','A DEFINIR PELO JURÍDICO',NULL);

CREATE TABLE processing_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  purpose text NOT NULL,
  data_categories text NOT NULL,
  data_subjects text NOT NULL,
  legal_basis text NOT NULL DEFAULT 'A DEFINIR — revisão jurídica (LGPD art. 7º/11)',
  agents text NOT NULL,
  sharing text NOT NULL,
  vendors text NOT NULL DEFAULT 'A DEFINIR',
  countries text NOT NULL DEFAULT 'A DEFINIR',
  retention text NOT NULL DEFAULT 'Ver retention_policies',
  controls text NOT NULL,
  owner text NOT NULL DEFAULT 'A DESIGNAR',
  reviewed_by text
);
INSERT INTO processing_activities(name, purpose, data_categories, data_subjects, agents, sharing, controls) VALUES
 ('Agendamento de consultas','Permitir marcação e gestão de consultas','Nome, contato, horário, profissional/local (revela informação de saúde por inferência)','Pacientes','Plataforma e organização (papéis a definir por finalidade)','Organização escolhida pelo paciente','RBAC por organização, ocupação global sem PII, auditoria'),
 ('Cadastro e autenticação','Identificar e proteger contas','E-mail, telefone, hash de senha, sessões, MFA','Pacientes, profissionais, equipe','Plataforma','Nenhum','Hash scrypt, MFA, sessões revogáveis'),
 ('Credenciamento de profissionais','Verificar inscrição e especialidade','CRM/UF, RQE, evidência de consulta oficial','Profissionais','Plataforma','Nenhum','Acesso restrito à moderação, auditoria'),
 ('Comunicação transacional','Lembretes e avisos de agendamento','E-mail, telefone, tipo de evento','Pacientes','Plataforma e provedor de mensagens (a definir)','Provedor de mensagens','Texto discreto, sem dados clínicos, preferências por canal'),
 ('Cobrança de assinatura SaaS','Cobrar o software de médicos/clínicas','Dados do contratante, faturas','Profissionais e clínicas','Plataforma e PSP (a definir)','PSP','Webhooks assinados, idempotência'),
 ('Feedback privado','Melhorar a experiência administrativa','Notas por dimensão, comentário','Pacientes','Plataforma','Nenhum (privado no piloto)','Triagem de conteúdo sensível, sem publicação');

CREATE TABLE security_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  status text NOT NULL DEFAULT 'identified'
    CHECK (status IN ('identified','contained','assessing','communicated','closed')),
  detected_at timestamptz NOT NULL,
  awareness_at timestamptz NOT NULL,             -- relógio do prazo parte da ciência de afetação de dados pessoais
  affects_personal_data boolean NOT NULL DEFAULT false,
  communication_due_at timestamptz,              -- calculado pela aplicação (3 dias úteis — J8, confirmar com jurídico)
  timeline jsonb NOT NULL DEFAULT '[]',
  lessons text,
  owner text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

-- ---------- Qualidade ----------
CREATE TABLE feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL UNIQUE REFERENCES appointments(id),   -- uma por consulta concluída
  organization_id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  punctuality smallint NOT NULL CHECK (punctuality BETWEEN 1 AND 5),
  communication smallint NOT NULL CHECK (communication BETWEEN 1 AND 5),
  structure smallint NOT NULL CHECK (structure BETWEEN 1 AND 5),
  comment text,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','published')),
  moderation_status text NOT NULL DEFAULT 'clean' CHECK (moderation_status IN ('clean','flagged','reviewed')),
  revision int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (visibility = 'private')                 -- publicação exige migração própria após revisão jurídica
);

CREATE TABLE moderation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','decided')),
  decision text,
  decided_by uuid REFERENCES users(id),
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id uuid REFERENCES users(id),
  practitioner_id uuid REFERENCES practitioners(id),
  description text NOT NULL,
  moderation_case_id uuid REFERENCES moderation_cases(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id),
  organization_id uuid REFERENCES organizations(id),
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
