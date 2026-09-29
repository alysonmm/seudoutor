-- Etapa 3 — Agenda: disponibilidade, ocupação global, reservas, agendamentos, outbox e notificações.

-- Idempotência de mutações críticas.
CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL REFERENCES users(id),
  operation text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response_status int NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, operation, key)
);

CREATE TABLE availability_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  location_id uuid NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- ISO: 1=segunda
  start_time time NOT NULL,
  end_time time NOT NULL,
  slot_step_minutes int NOT NULL DEFAULT 15 CHECK (slot_step_minutes BETWEEN 5 AND 240),
  valid_from date,
  valid_until date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_time < end_time),
  FOREIGN KEY (organization_id, practitioner_id) REFERENCES practitioner_memberships(organization_id, practitioner_id),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations(id, organization_id)
);
CREATE INDEX availability_rules_pract_idx ON availability_rules(practitioner_id, location_id) WHERE active;

-- Datas especiais prevalecem sobre a recorrência: se existir exceção na data para o par
-- médico+local, as regras semanais são ignoradas e valem apenas as janelas 'open'.
CREATE TABLE availability_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  location_id uuid NOT NULL,
  on_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('closed','open')),
  start_time time,
  end_time time,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'closed' AND start_time IS NULL AND end_time IS NULL)
      OR (kind = 'open' AND start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time)),
  FOREIGN KEY (organization_id, practitioner_id) REFERENCES practitioner_memberships(organization_id, practitioner_id),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations(id, organization_id)
);
CREATE INDEX availability_exceptions_idx ON availability_exceptions(practitioner_id, location_id, on_date);

-- Bloqueios (férias, feriados, ausências) restritos à organização que os criou.
CREATE TABLE schedule_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  location_id uuid,                             -- NULL = todos os locais da organização
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  FOREIGN KEY (organization_id, practitioner_id) REFERENCES practitioner_memberships(organization_id, practitioner_id)
);
CREATE INDEX schedule_blocks_idx ON schedule_blocks(practitioner_id, starts_at, ends_at);

-- Ocupação GLOBAL por profissional: sem dados pessoais, sem organização visível a terceiros.
-- A exclusão gist impede sobreposição entre reservas ativas, mesmo entre organizações.
CREATE TABLE practitioner_occupancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  during tstzrange NOT NULL,
  kind text NOT NULL CHECK (kind IN ('hold','appointment')),
  ref_id uuid NOT NULL,
  expires_at timestamptz,                       -- só para 'hold'; vencido = lógica de disponibilidade ignora
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT isempty(during) AND lower_inf(during) = false AND upper_inf(during) = false),
  CHECK ((kind = 'hold') = (expires_at IS NOT NULL)),
  CONSTRAINT practitioner_no_overlap EXCLUDE USING gist (practitioner_id WITH =, during WITH &&)
);
CREATE INDEX occupancies_expiry_idx ON practitioner_occupancies(expires_at) WHERE kind = 'hold';

ALTER TABLE practitioner_services ADD CONSTRAINT practitioner_services_full_key
  UNIQUE (id, organization_id, practitioner_id, location_id);

CREATE TABLE slot_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  location_id uuid NOT NULL,
  practitioner_service_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','released','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (practitioner_service_id, organization_id, practitioner_id, location_id)
    REFERENCES practitioner_services(id, organization_id, practitioner_id, location_id)
);
CREATE INDEX slot_holds_user_idx ON slot_holds(user_id, created_at DESC);

CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  location_id uuid NOT NULL,
  practitioner_service_id uuid NOT NULL,
  organization_patient_id uuid NOT NULL,
  requested_by_user_id uuid REFERENCES users(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL,
  source text NOT NULL CHECK (source IN ('app','phone','whatsapp','reception')),
  status text NOT NULL CHECK (status IN ('held','pending_approval','scheduled','cancelled','expired','rescheduled')),
  attendance text NOT NULL DEFAULT 'unconfirmed'
    CHECK (attendance IN ('unconfirmed','confirmed','checked_in','completed','no_show')),
  payer_type text NOT NULL CHECK (payer_type IN ('private','insurance')),
  insurance_product_id uuid REFERENCES insurance_products(id),
  snapshot jsonb NOT NULL,                      -- preço, serviço, endereço, identificação, versões das condições
  version int NOT NULL DEFAULT 1,
  hold_id uuid REFERENCES slot_holds(id),
  occupancy_id uuid UNIQUE REFERENCES practitioner_occupancies(id),
  rescheduled_from uuid REFERENCES appointments(id),
  needs_followup boolean NOT NULL DEFAULT false,
  followup_reason text,
  cancelled_by uuid REFERENCES users(id),
  cancel_reason text,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  CHECK ((payer_type = 'insurance') = (insurance_product_id IS NOT NULL)),
  CHECK (status NOT IN ('scheduled','pending_approval') OR occupancy_id IS NOT NULL),
  CHECK (attendance NOT IN ('completed','no_show') OR status = 'scheduled'),
  FOREIGN KEY (organization_id, practitioner_id) REFERENCES practitioner_memberships(organization_id, practitioner_id),
  FOREIGN KEY (practitioner_service_id, organization_id, practitioner_id, location_id)
    REFERENCES practitioner_services(id, organization_id, practitioner_id, location_id),
  FOREIGN KEY (organization_patient_id, organization_id) REFERENCES organization_patients(id, organization_id)
);
CREATE INDEX appointments_org_date_idx ON appointments(organization_id, starts_at);
CREATE INDEX appointments_practitioner_idx ON appointments(practitioner_id, starts_at);
CREATE INDEX appointments_patient_idx ON appointments(organization_patient_id, starts_at);
CREATE INDEX appointments_requester_idx ON appointments(requested_by_user_id, starts_at);
ALTER TABLE slot_holds ADD COLUMN appointment_id uuid REFERENCES appointments(id);

CREATE TABLE appointment_events (
  id bigserial PRIMARY KEY,
  appointment_id uuid NOT NULL REFERENCES appointments(id),
  organization_id uuid NOT NULL,
  type text NOT NULL,
  from_status text,
  to_status text,
  from_attendance text,
  to_attendance text,
  actor_user_id uuid,
  actor_kind text NOT NULL DEFAULT 'user',
  reason text,
  version int NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointment_events_idx ON appointment_events(appointment_id, id);

-- ---------- Outbox e notificações ----------
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  event_version int NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,                       -- IDs mínimos; nunca o objeto completo do paciente
  dedupe_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX outbox_pending_idx ON outbox_events(available_at) WHERE processed_at IS NULL;

CREATE TABLE notification_templates (
  key text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','whatsapp','push')),
  version int NOT NULL DEFAULT 1,
  subject text,
  body text NOT NULL,
  provider_template_ref text,                   -- aprovação do template no provedor (WhatsApp): pendente
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (key, channel, version)
);

CREATE TABLE notification_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  appointment_id uuid REFERENCES appointments(id),
  channel text NOT NULL CHECK (channel IN ('email','whatsapp','push')),
  template_key text NOT NULL,
  category text NOT NULL DEFAULT 'operational' CHECK (category IN ('operational','marketing')),
  send_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','skipped','failed','dead')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  skip_reason text,
  dedupe_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX notification_jobs_due_idx ON notification_jobs(send_at) WHERE status = 'pending';

CREATE TABLE delivery_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES notification_jobs(id),
  event text NOT NULL,
  provider text NOT NULL,
  detail text,
  at timestamptz NOT NULL DEFAULT now()
);

-- Caixa de correio de desenvolvimento/teste. Nunca usada em produção (adaptador falha fechado).
CREATE TABLE dev_mailbox (
  id bigserial PRIMARY KEY,
  to_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO notification_templates(key, channel, subject, body) VALUES
 ('appointment_scheduled','email','Você tem um agendamento','Você tem um agendamento. Consulte os detalhes no app: {{app_url}}/app/agendamentos'),
 ('appointment_reminder','email','Lembrete de agendamento','Você tem um agendamento em breve. Consulte os detalhes, confirme ou reagende no app: {{app_url}}/app/agendamentos'),
 ('appointment_cancelled','email','Atualização no seu agendamento','Houve uma atualização em um agendamento seu. Consulte os detalhes no app: {{app_url}}/app/agendamentos'),
 ('appointment_reminder','whatsapp',NULL,'Você tem um agendamento. Consulte os detalhes no app.');
