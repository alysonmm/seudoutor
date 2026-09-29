# Relatório de testes (execução real, ambiente local)

Ambiente: Linux, 4 vCPU Xeon 2,8 GHz, 16 GB, Node 22.22, PostgreSQL 16.13 local (mesma máquina). Dados 100% sintéticos. **Nada foi testado em infraestrutura de produção nem contra PSP/e-mail/WhatsApp reais.**

| Verificação | Resultado |
|---|---|
| `tsc --noEmit` | limpo |
| `eslint .` | limpo |
| `vitest` (4 arquivos, 75 testes, PostgreSQL real; banco recriado e migrado do zero a cada execução; pool de 5 conexões) | **75/75 passam** |
| Playwright E2E + axe (WCAG 2.2 A/AA, serious/critical) | **5/5 passam** |
| `next build` | passa |
| `npm audit --omit=dev` | ver saída do comando no CI/local (rodado; sem achados reportados na instalação) |
| `audit:secrets` (padrões básicos) | nenhum achado |
| Exercício de restauração local (`scripts/restore-drill.sh`) | dump→restore→migrar→contagens iguais→constraint presente: 2,4 s (base pequena) |

## Critérios de aceite (§23)

| ID | Situação | Onde |
|---|---|---|
| AC01 reservas simultâneas | **Testado** (10 concorrentes: 1 vence, 9 `slot_conflict` com alternativas; ocupação = 1) | etapa3 |
| AC02 médico em 2 clínicas | **Testado** (bloqueio global; sem vazamento; constraint no banco) | etapa3 |
| AC03 IDs adulterados | **Testado** (org cruzada, oferta e paciente de outra org, cancelar consulta alheia) | etapa3 |
| AC04 usuário removido | **Testado** (acesso e sessões revogados) | etapa1 |
| AC05 secretária × cobrança/exportação | **Testado** | etapa3 |
| AC06 pendente/suspenso | **Testado** | etapa2 |
| AC07 edição de especialidade/RQE | **Testado** | etapa2 |
| AC08 reagendamento falha | **Testado** | etapa3 |
| AC09 lembrete × cancelamento | **Testado** (incl. execução paralela) | etapa3 |
| AC10 webhook duplicado/falso/fora de ordem | **Testado** (contra o adaptador *sandbox*; formato real do PSP pendente) | etapa4 |
| AC11 checkout sem pagamento | **Testado** | etapa4 |
| AC12 reserva vence sem worker | **Testado** | etapa3 |
| AC13 preço muda | **Testado** | etapa3 |
| AC14 exclusão com retenção | **Testado** (fluxo técnico; fundamento jurídico pendente) | etapa4 |
| AC15 recusa marketing/geoloc. | **Testado** | etapa3/4 |
| AC16 GET de cancelamento | **Testado** | etapa3 |
| AC17 módulos bloqueados | **Testado** (403 em 6 módulos; flag não liga sem aprovação) | etapa3 |
| AC18 feedback sensível | **Testado** (sinaliza; banco impede publicar) | etapa4 |
| AC19 logout/offline | **Parcial**: E2E confirma logout→login exigido; SW não faz cache de dados privados. Sem teste em aparelho compartilhado real | e2e |
| AC20 restauração | **Parcial**: exercício local acima; **não** medido em infra real | script |
| AC21 CPF/telefone repetido | **Testado** (sem fusão; sem CPF no produto) | etapa4 |
| AC22 troca de organização em export | **Testado** (escopo fixado, acesso revalidado, arquivo 0600, expiração) | etapa4 |

Também testados: teclado (skip link), erro de rede na confirmação (não mostra sucesso), fuso (UTC-3/UTC-4), idempotência concorrente, MFA (replay, recuperação), CSRF de origem, `audit_events` append-only, minutas não publicáveis, PSP falha fechado em produção.

## Carga sintética (100 usuários concorrentes; 10 profissionais; excluídas integrações externas)

| Operação | p50 | p95 | p99 | Meta | Resultado |
|---|---|---|---|---|---|
| Confirmação (`bookAppointment`) | 447 ms | 657 ms | 658 ms | p95 ≤ 2 s | **Atende** (100/100 ok) |
| Busca (`searchPractitioners`, chamada direta no módulo) | 4,6 s | 4,7 s | 4,7 s | p95 ≤ 1,5 s | **NÃO atende** |

Após otimização (janelas 3/7/14 dias, cache de parâmetros) a busca caiu de p95 ≈ 11 s para ≈ 4,7 s, ainda acima da meta. Gargalo: o próximo horário é calculado por resultado, com várias consultas cada, com 100 buscas simultâneas disputando 20 conexões. Caminho recomendado: pré-calcular/cachear `next_slot` por oferta (invalidado por mudanças de agenda/ocupação) — **não implementado**. O benchmark mede o módulo, não HTTP/Next; usar um teste de carga em ambiente representativo. Um deadlock real de pool sob carga foi encontrado e **corrigido** durante este benchmark (regressão coberta por rodar a suíte com pool=5).

## Não testado
Restauração em produção, pentest, PSP/e-mail/WhatsApp reais, leitores de tela/usuários reais, navegadores além do Chromium, carga por HTTP, `.github/workflows/ci.yml` (nunca executado).
