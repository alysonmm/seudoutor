# Inventário de operações de tratamento (rascunho) e RIPD interno

> Rascunho de engenharia para o encarregado e o jurídico. Bases legais, prazos e fornecedores estão **em aberto** (`A DEFINIR`). O inventário vivo está na tabela `processing_activities`; a retenção em `retention_policies`.

## Operações

| Operação | Finalidade | Dados | Titulares | Compartilhamento | Base legal | Retenção | Controles |
|---|---|---|---|---|---|---|---|
| Cadastro/autenticação | Identificar e proteger contas | e-mail, telefone (opcional), hash scrypt, sessões, TOTP cifrado | Todos | — | A DEFINIR | A DEFINIR | MFA, rate limit, anti-enumeração, sessões revogáveis |
| Agendamento | Marcar e gerir consultas | nome, contato, profissional/local/horário, origem, snapshot comercial (**pode revelar saúde**) | Pacientes | Organização escolhida | A DEFINIR (art. 11) | A DEFINIR (agenda administrativa não herda prazo de prontuário) | RBAC por organização e escopo, ocupação global sem PII, auditoria |
| Comunicação operacional | Lembretes/avisos | e-mail, evento | Pacientes | Provedor de e-mail (A DEFINIR) | A DEFINIR | corpo mínimo | Texto discreto, links assinados, preferências |
| Credenciamento | Verificar CRM/RQE | CRM/UF, RQE, evidência | Profissionais | — | A DEFINIR | A DEFINIR | Acesso só da moderação, auditoria |
| Assinatura SaaS | Cobrar o software | contratante, faturas | Profissionais | PSP (A DEFINIR) | A DEFINIR | obrigações fiscais/contratuais | Webhook assinado; sem dados de cartão na plataforma |
| Feedback privado | Melhorar experiência administrativa | notas, comentário | Pacientes | Nenhum | A DEFINIR | A DEFINIR | Triagem de conteúdo sensível, sem publicação, médias com supressão |
| Suporte | Atender solicitações | assunto/mensagem | Todos | — | A DEFINIR | A DEFINIR | Metadados mínimos; sem "entrar como" |
| Métricas | Gestão | agregados | — | — | A DEFINIR | — | Sem feed individual; supressão de grupos pequenos |

## Decisões de arquitetura de privacidade implementadas

- Sem pixels de anúncios, gravação de sessão ou analytics de terceiros. Único cookie: `sid` (HttpOnly).
- Sem CPF: identificação do paciente por conta verificada; nenhuma fusão automática por nome/telefone.
- Sem campo de história clínica, sem upload de exames/receitas; avisos para não inserir dados clínicos; triagem de feedback sinaliza diagnóstico/documento/terceiros.
- Consentimentos opcionais em `consent_events` (histórico), separados de aceite de termos; nunca pré-marcados; recusar não bloqueia busca/agendamento (AC15).
- Portal do titular: exportação (JSON), pedidos com protocolo/prazo por tipo/decisão fundamentada, eliminação com **minimização** (identificação removida, registro administrativo retido sem identificação direta — fundamento a confirmar, D8).
- Dados sintéticos em dev/homologação; seed recusa produção; nenhuma cópia de produção para dev.
- PWA sem cache offline de dados privados; `Clear-Site-Data` no logout.

## Riscos de privacidade identificados (RIPD interno — a completar pelo encarregado)

1. Inferência de saúde por especialidade/horário: mitigado por texto discreto e sem marketing derivado; residual em e-mails/logs do provedor (A DEFINIR).
2. Acesso indevido por equipe: escopo por médico/unidade, auditoria; falta treinamento/termo assinado (minuta em `docs/legal`).
3. Backups: política de restauração deve **reaplicar exclusões** — procedimento documentado no runbook, ainda não exercitado em infraestrutura real.
4. Suboperadores/transferência internacional: sem fornecedores definidos.
5. Menores: fora do escopo (recurso desligado).
