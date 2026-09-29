-- Exportações: pedido registrado, arquivo privado com expiração, revalidação de acesso na execução.
CREATE TABLE data_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),   -- escopo fixado no pedido
  requested_by uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('appointments_csv')),
  params jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','denied','expired','failed')),
  row_count int,
  file_path text,
  denial_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL
);
