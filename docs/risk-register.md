# Registro de riscos

| ID | Risco | Prob. | Impacto | Mitigação implementada | Residual / ação |
|---|---|---|---|---|---|
| R1 | Dupla marcação do mesmo horário | Média | Alto | Constraint `EXCLUDE gist` global por profissional + testes concorrentes (10 simultâneos) | Monitorar `slot_conflict`; teste de carga maior |
| R2 | Vazamento entre organizações (IDOR) | Média | Crítico | Autorização por objeto no servidor, 404 fora do escopo, FKs compostas (org, recurso) | Pentest externo pendente |
| R3 | Conta profissional sem 2º fator | Baixa | Alto | MFA obrigatório na camada de autenticação | UX de recuperação de MFA precisa de procedimento operacional |
| R4 | Ativação de assinatura por evento falso | Baixa | Alto | HMAC + timestamp + idempotência + conferência de valor | PSP real: mapear formato e IPs; chave rotacionável |
| R5 | E-mail em texto claro expõe agendamento | Média | Médio | Texto discreto | Provedor de e-mail e transferência (D9) indefinidos |
| R6 | Módulos regulados usados sem aprovação | Baixa | Alto | Flags falha-fechada + constraint + rotas 403/501 | Revisão periódica de `feature_approvals` |
| R7 | Documentos legais ausentes/não aprovados | Alta | Alto | Produção bloqueia cadastro sem versão publicada | Contratar revisão jurídica |
| R8 | Perda de dados / RPO 1h RTO 4h | Média | Alto | Migrações reprodutíveis; runbook de backup/restauração | **Não testado em infraestrutura real**; depende de hospedagem |
| R9 | Indisponibilidade do worker | Média | Médio | Vencimento de hold e validação de lembretes são lógicos/independentes do worker | Alertas e responsável a definir |
| R10 | Verificação de CRM feita errada | Média | Alto | Evidência obrigatória (fonte, data, responsável, situação, próxima revisão); nada simulado | Reverificação periódica: falta rotina de lembrete de `next_review_at` |
| R11 | Acessibilidade sem auditoria humana | Média | Médio | axe (WCAG 2.2 AA) nas telas principais, teclado, foco visível | Auditoria com leitores de tela e usuários |
| R12 | Rate limit por IP confia em `x-forwarded-for` | Média | Baixo | Limite também por e-mail/conta | Configurar proxy confiável no deploy |
| R13 | Ícones PWA em baixa resolução (fonte 285 px ampliada) | Alta | Baixo | — | Fornecer arte ≥ 512 px |
| R14 | Segredos em dev com valores fixos | Baixa | Alto se vazar p/ prod | Em produção ausência de segredo é erro fatal | CI: varredura de segredos + dependências |
| R15 | Fuso/horário de verão | Baixa | Médio | Luxon por IANA; teste UTC-3/UTC-4 | Testar mudança de regra de fuso |
| R16 | Cobrança de "excedente" de mensagens | — | — | Não implementado (sem cobrança automática) | — |
