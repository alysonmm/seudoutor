# Backlog priorizado e pendências

## A. Bloqueios de produção (briefing §24) — situação real
| Bloqueio | Situação |
|---|---|
| Operador empresarial, contatos verdadeiros, enquadramento | **Aberto** — campos `[A PREENCHER]`; D1 |
| Documentos jurídicos revisados e publicados | **Aberto** — só minutas em `docs/legal` |
| Matriz de finalidades/bases, fornecedores, retenção, transferências | **Aberto** — rascunhos; D4, D8, D9 |
| Responsáveis por privacidade, suporte, segurança e incidentes | **Aberto** — não designados |
| Credenciamento e gestão de denúncias operacionais | Parcial — fluxo de credenciamento existe; **denúncias de terceiros (endpoint/tela `reports`) não implementadas** |
| Testes críticos de isolamento, concorrência, cobrança, recuperação | Isolamento/concorrência/cobrança **testados localmente**; **recuperação (AC20) não testada** |
| Segredos e integrações de produção; mensagens de teste desativadas | **Aberto** — sem PSP, SMTP, WhatsApp; adaptadores de teste falham fechado em produção |
| Monitoramento, backups, rollback, resposta a incidentes funcionando | **Aberto** — só runbook |
| Recursos bloqueados inacessíveis; sem campanhas de pontos | Atendido no código (403) |
| Revisão final de normas na data do lançamento | **Aberto** |

## B. Depende de contratação/credencial (não inventar)
1. PSP para assinaturas (contrato, chaves, formato real de webhook, conciliação) — hoje só sandbox.
2. Provedor de e-mail transacional (SMTP/API) — hoje `dev_mailbox`.
3. WhatsApp Business (provedor oficial, templates aprovados, cotas/custos; flag `whatsapp_messages`) — não implementado.
4. Geocodificação (endereço → coordenadas) — hoje manual.
5. Armazenamento privado de objetos (documentos de credenciamento, exportações) — exportações em disco local `storage/private` (dev).
6. Hospedagem PostgreSQL com backup/PITR, monitoramento e alertas.
7. Fiscal/contábil: nota do software; recibo operacional atual não é nota fiscal.

## C. Funcionalidades do escopo MVP que ficaram incompletas (transparência)
- **Upload/gestão de documentos mínimos do credenciamento**: não implementado (verificação é por evidência manual; sem armazenamento de documentos).
- **Denúncias** (`reports`) e fluxo de decisão/contestação de avaliações: tabelas existem; sem tela/endpoint.
- **Reverificação periódica**: `next_review_at` gravado, sem alerta/rotina.
- **Painel de suspensão/reabilitação e moderação de feedback na UI**: suspender/reabilitar só via API; moderação lista casos, sem tela de decisão.
- **Vínculo de paciente cadastrado pela recepção com conta (convite)**: tabela `patient_link_invitations` criada; fluxo de envio/aceite **não implementado** (registro manual não cria vínculo — comportamento seguro).
- **Edição de organização/local (UPDATE)**, múltiplos idiomas, múltiplas especialidades/CRMs na UI (API aceita vários; tela edita 1).
- **Recifrar segredos MFA ao rotacionar `APP_ENCRYPTION_KEY`**: script ausente.
- **OpenAPI** formal.
- **Cobrança de excedente/cota de WhatsApp**: deliberadamente ausente (sem cobrança automática).
- Ícones PWA a partir de arte 285 px (ampliada) — pedir arte ≥ 512 px.
- Página de "esqueci o MFA" (procedimento operacional para reset administrativo `adminResetMfa` existe no módulo, sem tela).

## D. Roadmap futuro (cada item com briefing, testes e condições próprias)
Avaliações públicas · dependentes · pagamento de consulta por PSP · exames/laboratórios · apps nativos · telemedicina · integração bidirecional de calendários (o `.ics` individual também não foi implementado) · expansão a outros conselhos profissionais. **Pontos/cashback**: mantido só como hipótese registrada; nenhuma implementação nem contorno.

## E. Melhorias técnicas
Teste de restauração de backup (AC20) · pentest externo · CI: workflow em `.github/workflows/ci.yml` criado mas **nunca executado** (falta SBOM e varredura dedicada de segredos) · teste de carga em ambiente representativo · PostGIS se necessário · particionamento de `audit_events`.
