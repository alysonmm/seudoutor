ALTER TABLE practitioners ADD COLUMN display_name text;
INSERT INTO system_settings(key, value, description) VALUES
 ('booking_min_notice_minutes','60','Antecedência mínima para marcar (padrão; hipótese editável)'),
 ('booking_horizon_days','60','Horizonte de abertura da agenda em dias');
