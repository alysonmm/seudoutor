-- Etapa 2 — Oferta e descoberta: profissionais, credenciamento, locais, serviços, convênios, pacientes.

CREATE TABLE specialties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true
);

-- Identidade profissional GLOBAL (uma pessoa, várias organizações).
CREATE TABLE practitioners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE REFERENCES users(id),
  slug text UNIQUE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_review','needs_changes','approved','suspended','rejected')),
  status_reason text,
  current_public_version_id uuid,              -- FK adicionada abaixo; só muda por aprovação
  -- campos públicos de baixo risco (não exigem nova análise documental)
  bio text,
  languages text[] NOT NULL DEFAULT '{}',
  age_min int,
  age_max int,
  travel_buffer_minutes int NOT NULL DEFAULT 0 CHECK (travel_buffer_minutes BETWEEN 0 AND 240),
  next_review_at date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (age_min IS NULL OR age_max IS NULL OR age_min <= age_max)
);

CREATE TABLE professional_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  council text NOT NULL DEFAULT 'CRM' CHECK (council IN ('CRM')),
  uf char(2) NOT NULL,
  number text NOT NULL CHECK (number ~ '^[0-9]{1,10}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (council, uf, number)                 -- mesma inscrição não pode duplicar identidade
);

CREATE TABLE practitioner_specialties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  specialty_id uuid NOT NULL REFERENCES specialties(id),
  rqe text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (practitioner_id, specialty_id)
);

-- Versões do bloco de identidade (nome, CRM, especialidades/RQE). Publicação usa somente a aprovada.
CREATE TABLE public_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  version int NOT NULL,
  status text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','approved','rejected','superseded','needs_changes')),
  data jsonb NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id),
  review_notes text,
  UNIQUE (practitioner_id, version)
);
ALTER TABLE practitioners
  ADD CONSTRAINT practitioners_current_version_fk
  FOREIGN KEY (current_public_version_id) REFERENCES public_profile_versions(id);

-- Evidência de verificação (fonte, data, responsável, inscrição, situação, próxima revisão).
CREATE TABLE credential_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  profile_version_id uuid REFERENCES public_profile_versions(id),
  source text NOT NULL,                        -- ex.: 'consulta oficial manual — portal do CRM'
  registration text NOT NULL,                  -- ex.: CRM/SP 123456
  registration_situation text NOT NULL,
  checked_at date NOT NULL,
  checked_by uuid NOT NULL REFERENCES users(id),
  next_review_at date NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Vínculo profissional <-> organização.
CREATE TABLE practitioner_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, practitioner_id)
);

CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  street text NOT NULL,
  number text,
  complement text,
  neighborhood text NOT NULL,
  city text NOT NULL,
  uf char(2) NOT NULL,
  postal_code text,
  latitude double precision,                   -- informado/geocodificado com adaptador autorizado
  longitude double precision,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  accessibility text[] NOT NULL DEFAULT '{}',
  arrival_instructions text,
  admin_phone text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE INDEX locations_city_idx ON locations(lower(city), lower(neighborhood)) WHERE active;

CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, name)
);

-- Serviço oferecido por médico, em um local, com duração/preço. Preço NULL = "não informado" (nunca R$ 0).
CREATE TABLE practitioner_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  location_id uuid NOT NULL,
  service_id uuid NOT NULL,
  duration_minutes int NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  prep_minutes int NOT NULL DEFAULT 0 CHECK (prep_minutes BETWEEN 0 AND 120),
  buffer_minutes int NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 120),
  price_cents integer CHECK (price_cents IS NULL OR price_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'BRL',
  accepts_private boolean NOT NULL DEFAULT true,
  payment_methods text[] NOT NULL DEFAULT '{}',
  conditions text,
  return_policy text,                          -- política de retorno informada pelo médico (sujeita a revisão)
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (practitioner_id, location_id, service_id),
  FOREIGN KEY (organization_id, practitioner_id) REFERENCES practitioner_memberships(organization_id, practitioner_id),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations(id, organization_id),
  FOREIGN KEY (service_id, organization_id) REFERENCES services(id, organization_id)
);

CREATE TABLE insurers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE insurance_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  insurer_id uuid NOT NULL REFERENCES insurers(id),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (insurer_id, name)
);
-- operadora + PRODUTO + médico + local + serviço, com data de atualização.
CREATE TABLE accepted_insurance_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_service_id uuid NOT NULL REFERENCES practitioner_services(id),
  insurance_product_id uuid NOT NULL REFERENCES insurance_products(id),
  requires_authorization boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (practitioner_service_id, insurance_product_id)
);

-- ---------- Pacientes ----------
CREATE TABLE patient_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  birth_date date,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Registro local (escopo da organização). Nunca fundido automaticamente por nome/telefone/CPF.
CREATE TABLE organization_patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  full_name text NOT NULL,
  phone text,
  email citext,
  created_via text NOT NULL CHECK (created_via IN ('app','reception')),
  created_by uuid REFERENCES users(id),
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);
CREATE INDEX org_patients_org_idx ON organization_patients(organization_id);

-- Vínculo conta global <-> registro local, somente após verificação.
CREATE TABLE patient_account_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_patient_id uuid NOT NULL REFERENCES organization_patients(id),
  patient_account_id uuid NOT NULL REFERENCES patient_accounts(id),
  verified_at timestamptz NOT NULL,
  verification_method text NOT NULL CHECK (verification_method IN ('self_booking','invitation')),
  UNIQUE (organization_patient_id),
  UNIQUE (organization_patient_id, patient_account_id)
);

CREATE TABLE patient_link_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  organization_patient_id uuid NOT NULL,
  email citext NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_patient_id, organization_id) REFERENCES organization_patients(id, organization_id)
);

CREATE TABLE notification_preferences (
  user_id uuid NOT NULL REFERENCES users(id),
  channel text NOT NULL CHECK (channel IN ('email','whatsapp','push')),
  category text NOT NULL CHECK (category IN ('operational','marketing')),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel, category)
);

-- Base de referência estrutural (não é dado empresarial): especialidades comuns editáveis pelo admin.
INSERT INTO specialties(slug, name) VALUES
 ('clinica-medica','Clínica Médica'),('cardiologia','Cardiologia'),('dermatologia','Dermatologia'),
 ('ginecologia-obstetricia','Ginecologia e Obstetrícia'),('ortopedia','Ortopedia e Traumatologia'),
 ('oftalmologia','Oftalmologia'),('psiquiatria','Psiquiatria'),('endocrinologia','Endocrinologia');
