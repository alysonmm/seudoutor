-- Etapa 1 — Fundação: identidade, organizações, RBAC, auditoria, flags.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- Identidade ----------
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  email_verified_at timestamptz,
  phone text,
  phone_verified_at timestamptz,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','deleted')),
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,            -- sha256 do token; token bruto só no cookie
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  mfa_verified_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  user_agent text
);
CREATE INDEX sessions_user_idx ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE contact_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  channel text NOT NULL CHECK (channel IN ('email','phone')),
  destination text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('verify_contact','reset_password')),
  code_hash text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_verifications_dest_idx ON contact_verifications(destination, purpose, created_at DESC);

CREATE TABLE mfa_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL DEFAULT 'totp' CHECK (kind IN ('totp')),
  secret_enc text NOT NULL,                   -- AES-256-GCM (chave em APP_ENCRYPTION_KEY)
  confirmed_at timestamptz,
  last_used_step bigint,                      -- anti-replay de TOTP
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mfa_one_active_per_user ON mfa_methods(user_id) WHERE confirmed_at IS NOT NULL;

CREATE TABLE mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_limits (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  count int NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

-- ---------- Organizações e RBAC ----------
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('individual','clinic')),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  key text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE roles (
  id text PRIMARY KEY,                         -- ex.: clinic_manager
  scope text NOT NULL CHECK (scope IN ('organization','platform')),
  label text NOT NULL,
  requires_mfa boolean NOT NULL DEFAULT true
);

CREATE TABLE role_permissions (
  role_id text NOT NULL REFERENCES roles(id),
  permission text NOT NULL REFERENCES permissions(key),
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  role_id text NOT NULL REFERENCES roles(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by uuid REFERENCES users(id),
  UNIQUE (user_id, organization_id, role_id)
);
CREATE INDEX memberships_org_idx ON memberships(organization_id) WHERE status = 'active';

-- Escopo restrito de um vínculo (secretária só vê médicos/unidades atribuídos).
CREATE TABLE member_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES memberships(id),
  scope_type text NOT NULL CHECK (scope_type IN ('practitioner','location')),
  scope_id uuid NOT NULL,
  UNIQUE (membership_id, scope_type, scope_id)
);

-- Equipe da plataforma (papéis globais).
CREATE TABLE platform_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  role_id text NOT NULL REFERENCES roles(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id)
);

-- Acesso excepcional de suporte: motivo, ticket, prazo, aprovação. Sem "entrar como paciente".
CREATE TABLE support_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  granted_to uuid NOT NULL REFERENCES users(id),
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  ticket_ref text NOT NULL,
  reason text NOT NULL,
  approved_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by <> granted_to)
);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  email citext NOT NULL,                       -- destinatário verificado no aceite
  role_id text NOT NULL REFERENCES roles(id),
  scopes jsonb NOT NULL DEFAULT '[]',
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Auditoria (append-only) ----------
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_kind text NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user','system','webhook')),
  organization_id uuid,
  action text NOT NULL,
  object_type text,
  object_id text,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_org_idx ON audit_events(organization_id, at DESC);
CREATE INDEX audit_action_idx ON audit_events(action, at DESC);

CREATE FUNCTION audit_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events é append-only';
END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

-- ---------- Feature flags (falha fechada) ----------
CREATE TABLE feature_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_key text NOT NULL,
  decision_ref text NOT NULL,                  -- referência ao parecer/decisão aprovada (documento externo)
  scope text NOT NULL,                         -- escopo exato aprovado
  approved_by text NOT NULL,                   -- pessoa/cargo que aprovou (humano)
  approved_at date NOT NULL,
  review_by date NOT NULL,                     -- expirada => flag volta a falhar fechada
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feature_flags (
  key text PRIMARY KEY,
  description text NOT NULL,
  regulated boolean NOT NULL DEFAULT false,    -- exige feature_approvals válido
  implemented boolean NOT NULL DEFAULT false,  -- false: mesmo habilitada, não há código a executar
  enabled boolean NOT NULL DEFAULT false,
  approval_id uuid REFERENCES feature_approvals(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (enabled AND regulated AND approval_id IS NULL))
);

CREATE TABLE system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  description text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Seed de permissões e papéis (estrutura, não dados de negócio) ----------
INSERT INTO permissions(key, description) VALUES
 ('org.settings.manage','Configurar a organização'),
 ('org.members.manage','Convidar/remover equipe e definir escopos'),
 ('org.locations.manage','Gerenciar locais'),
 ('org.services.manage','Gerenciar serviços, preços e convênios aceitos'),
 ('profile.manage','Editar perfil profissional e enviar ao credenciamento'),
 ('schedule.read','Ver agenda'),
 ('schedule.manage','Gerenciar regras de disponibilidade, exceções e bloqueios'),
 ('appointment.read','Ver agendamentos'),
 ('appointment.create','Criar agendamento manual'),
 ('appointment.update','Confirmar, reagendar, cancelar, check-in'),
 ('appointment.close','Registrar conclusão/falta'),
 ('patient.read_admin','Ver dados administrativos de pacientes do escopo'),
 ('patient.create','Cadastrar paciente local'),
 ('billing.read','Ver assinatura e cobranças'),
 ('billing.manage','Contratar/cancelar assinatura'),
 ('reports.read','Ver relatórios operacionais'),
 ('reports.financial','Ver relatórios financeiros'),
 ('export.general','Exportações gerais'),
 ('credential.review','Revisar/aprovar/suspender credenciamento'),
 ('moderation.review','Analisar denúncias e feedback sinalizado'),
 ('subscription.admin','Administrar planos e assinaturas da plataforma'),
 ('support.ticket','Atender tickets (metadados mínimos)'),
 ('audit.read','Consultar trilha de auditoria'),
 ('incident.manage','Gerir incidentes de segurança'),
 ('privacy.manage','Tratar solicitações de titulares'),
 ('feature.manage','Gerir feature flags e aprovações'),
 ('platform.staff.manage','Gerir equipe da plataforma');

INSERT INTO roles(id, scope, label, requires_mfa) VALUES
 ('clinic_manager','organization','Gestor da clínica',true),
 ('practitioner','organization','Médico',true),
 ('secretary','organization','Secretária',true),
 ('finance','organization','Financeiro da clínica',true),
 ('support','platform','Suporte da plataforma',true),
 ('moderator','platform','Moderação / credenciamento',true),
 ('security_admin','platform','Administrador de segurança',true),
 ('platform_admin','platform','Administrador da plataforma',true);

INSERT INTO role_permissions(role_id, permission) VALUES
 ('clinic_manager','org.settings.manage'),('clinic_manager','org.members.manage'),('clinic_manager','org.locations.manage'),
 ('clinic_manager','org.services.manage'),('clinic_manager','schedule.read'),('clinic_manager','schedule.manage'),
 ('clinic_manager','appointment.read'),('clinic_manager','appointment.create'),('clinic_manager','appointment.update'),
 ('clinic_manager','appointment.close'),('clinic_manager','patient.read_admin'),('clinic_manager','patient.create'),
 ('clinic_manager','billing.read'),('clinic_manager','billing.manage'),('clinic_manager','reports.read'),
 ('clinic_manager','reports.financial'),('clinic_manager','export.general'),
 ('practitioner','profile.manage'),('practitioner','schedule.read'),('practitioner','schedule.manage'),
 ('practitioner','appointment.read'),('practitioner','appointment.create'),('practitioner','appointment.update'),
 ('practitioner','appointment.close'),('practitioner','patient.read_admin'),('practitioner','patient.create'),
 ('practitioner','reports.read'),
 ('secretary','schedule.read'),('secretary','appointment.read'),('secretary','appointment.create'),
 ('secretary','appointment.update'),('secretary','appointment.close'),('secretary','patient.read_admin'),
 ('secretary','patient.create'),
 ('finance','billing.read'),('finance','billing.manage'),('finance','reports.financial'),
 ('support','support.ticket'),
 ('moderator','credential.review'),('moderator','moderation.review'),
 ('security_admin','audit.read'),('security_admin','incident.manage'),('security_admin','privacy.manage'),
 ('platform_admin','subscription.admin'),('platform_admin','feature.manage'),('platform_admin','platform.staff.manage'),
 ('platform_admin','privacy.manage');

-- Módulos bloqueados/posteriores: nascem desligados. Regulados exigem aprovação registrada.
INSERT INTO feature_flags(key, description, regulated, implemented) VALUES
 ('public_reviews','Publicação de avaliações e filtro por nota',true,false),
 ('dependents','Agendamento para menores/dependentes',true,false),
 ('clinic_payments','Pagamento de consultas por PSP',true,false),
 ('loyalty_points','Pontos, cashback, carteira e resgate',true,false),
 ('telehealth','Telemedicina',true,false),
 ('exams','Exames e laboratórios',true,false),
 ('sponsored_highlight','Destaque patrocinado em busca',true,false),
 ('whatsapp_messages','Envio de WhatsApp via provedor oficial',false,false),
 ('clinical_records','Prontuário, receita e atestado',true,false);

INSERT INTO system_settings(key, value, description) VALUES
 ('hold_ttl_seconds','300','Duração da reserva temporária (padrão 5 min)'),
 ('hold_rate_limit_per_10min','20','Máximo de reservas temporárias por usuário em 10 min'),
 ('reminder_offsets_minutes','[1440,180]','Lembretes 24h e 3h antes'),
 ('trial_days','14','Dias de teste gratuito (hipótese comercial editável)'),
 ('billing_grace_days','7','Carência após falha de pagamento (a validar)'),
 ('default_timezone','"America/Sao_Paulo"','Fuso padrão'),
 ('privacy_request_sla_days','{"access":15,"correction":15,"portability":15,"erasure":15,"revocation":15,"other":15}','PLACEHOLDER de prazo interno por direito — definir com encarregado/jurídico'),
 ('small_group_suppression_min','5','Supressão de grupos pequenos em métricas agregadas');
