# Decisões jurídicas e pendências de aprovação humana

> Este projeto **não** contém parecer jurídico. Nada aqui foi aprovado por advogado, conselho, ANPD ou autoridade. Cada item abaixo é uma **decisão a tomar por pessoa habilitada** antes de produção. O código apenas impede o uso das funções dependentes (falha fechada).

Referências do briefing: J1 CFM 2.336/2023 · J2 CFM 2.460/2026 · J3 Código de Ética Médica · J4 LGPD · J5 CDC · J6 Decreto 7.962/2013 · J7 Marco Civil · J8 ANPD Res. 15/2024 · J9 ANPD Res. 19/2024 · J10 CFM 2.314/2022. **Revalidar todas na data do lançamento.**

| ID | Decisão | Por que importa | O que o sistema faz hoje | Responsável | Status |
|---|---|---|---|---|---|
| D1 | Enquadramento empresarial (CNAE, natureza), necessidade de registro no CRM e responsável técnico | Definir se a operação exige inscrição/RT (não presumir dispensa por "marketplace") | Nada assume; rodapé e termos têm lacunas `[A PREENCHER]` | Advogado + contador | **Pendente** |
| D2 | Compatibilidade da assinatura fixa com CFM 2.460/2026 art. 6º (serviços administrativos reais) e ausência de vantagem por encaminhamento | Risco de a operação ser vista como captação/comissão | Sem comissão, sem peso de plano na busca, sem destaque patrocinado, sem pontos | Advogado | **Pendente** |
| D3 | Publicidade médica (CFM 2.336/2023): perfil, preços, "registro verificado", texto da bio | Limites de divulgação | Selo diz "registro verificado em [data]", sem endosso; bio em texto puro; sem avaliação/ranking públicos | Advogado + credenciamento | **Pendente** |
| D4 | Base legal por finalidade (LGPD art. 7º/11) e papéis controlador/operador | Agendamento pode revelar dado de saúde (sensível) | `processing_activities` com `A DEFINIR`; minimização; sem dados clínicos | Encarregado + advogado | **Pendente** |
| D5 | Instrumentos de dados (papéis, suboperadores, incidentes, devolução/eliminação) | Contratos com fornecedores | Minuta dos contratos não incluída (depende dos fornecedores) | Advogado | **Pendente** |
| D6 | Direito de arrependimento / CDC para contratante PJ e cláusulas de cancelamento | Exposição a cláusula abusiva | Fluxo de solicitação de arrependimento/restituição com protocolo e análise humana; cancelamento pelo painel com comprovante | Advogado | **Pendente** |
| D7 | Prazos por direito do titular (LGPD) | Não usar prazo genérico | `system_settings.privacy_request_sla_days` com **placeholder**; decisão fundamentada obrigatória | Encarregado | **Pendente** |
| D8 | Matriz de retenção (registros de acesso J7 art. 15; incidentes ≥ 5 anos J8; agenda; cobrança; backups) | Reter o necessário, apagar o resto | `retention_policies` como `proposed`, sem aprovador | Advogado + encarregado | **Pendente** |
| D9 | Transferência internacional (hospedagem, e-mail, PSP, suporte) — J9 | Mecanismo aplicável | Não há fornecedor definido | Encarregado | **Pendente** |
| D10 | Dependentes/menores (representação, adolescentes, guarda) | Risco alto | Recurso **desligado** (`dependents`); API responde 403 | Advogado especializado | Bloqueado |
| D11 | Pagamento de consulta por PSP; carteira; parcelamento; antecipação | Arranjos de pagamento, BCB, conciliação, chargeback | **Desligado** (`clinic_payments`); consulta é paga no local | Advogado + financeiro | Bloqueado |
| D12 | Pontos, cashback, carteira, resgate por medicamentos | Vantagem econômica, CFM 2.460, Anvisa, tributação, dados de saúde | **Desligado**; nada de contorno ("clube de vantagens") | Advogado; memorando conforme §15 do briefing | Bloqueado |
| D13 | Telemedicina (CFM 2.314/2022), prontuário, receita, atestado | Requisitos assistenciais | **Desligado** (`telehealth`, `clinical_records`) | Advogado + RT | Bloqueado |
| D14 | Exames/laboratórios/farmácias | Sanitário/Anvisa/credenciamento | **Desligado** (`exams`) | Advogado | Bloqueado |
| D15 | Avaliações públicas, filtro por nota | Publicidade médica, moderação, contestação | Feedback **privado**; constraint no banco impede `published` | Advogado | Bloqueado |
| D16 | Nota fiscal do software e da consulta | Obrigações distintas | Somente recibo operacional | Contador | **Pendente** |
| D17 | Marca "Seu Doutor": pesquisa de marca/domínio (INPI), titularidade das logos, licença de fotos | Direito de marca/autor | Logos fornecidas pelo cliente em `public/brand`; sem pesquisa feita | Advogado de PI | **Pendente** |
| D18 | Licença/cessão do código e dependências | Titularidade | Dependências de terceiros listadas em `package.json`; sem auditoria de licenças | Advogado | **Pendente** |

## Como uma função bloqueada seria liberada no futuro

1. Decisão jurídica documentada com referência, escopo exato, aprovador e data de revisão.
2. Implementação, migrações, testes e contratos do módulo.
3. Registro em `feature_approvals` e ativação da flag por `platform_admin` (`approveAndEnableFlag`). Enquanto `implemented=false` a função continua inacessível.

## Publicação de documentos

`document_versions.status='published'` exige `approved_by` e `approved_at` (constraint). Em produção o cadastro falha (`document_not_published`) sem versão publicada. Todos os textos em `docs/legal/` são **MINUTAS**.
