# Permissões (RBAC + escopo)

Regras: negar por padrão; autorização no servidor, em cada objeto, consultando o banco a cada chamada; o cliente nunca define a organização autorizada (o `orgId` da URL só vale se houver vínculo ativo). Administrador global **não** herda acesso a dados de pacientes.

## Papéis de organização (`roles`, escopo `organization`)

| Papel | Escopo efetivo | Permissões |
|---|---|---|
| `clinic_manager` (gestor) | toda a organização | configurações, equipe, locais, serviços, agenda, consultas, pacientes administrativos, assinatura, relatórios (inclui financeiros), exportação |
| `practitioner` (médico) | apenas o **próprio** profissional | perfil/credenciamento, agenda e consultas próprias, pacientes vinculados aos seus atendimentos, relatórios operacionais |
| `secretary` | somente médicos/unidades atribuídos (`member_scopes`); **sem atribuição = nada** | agenda (leitura), consultas (criar/atualizar/concluir), pacientes administrativos. **Sem** assinatura, banco/credenciais, equipe, exportação geral, relatórios financeiros |
| `finance` | organização | assinatura e relatórios financeiros. Sem agenda clínica/pacientes |

Um usuário pode ter vários papéis e várias organizações; a permissão é a união dos vínculos ativos. Conta de paciente é independente (não mistura acessos).

## Papéis de plataforma (`platform_staff`)

| Papel | Permissões |
|---|---|
| `moderator` | revisar credenciamento, suspender/reabilitar, moderação |
| `platform_admin` | planos e assinaturas (metadados), flags, equipe da plataforma, privacidade |
| `security_admin` | auditoria, incidentes, privacidade |
| `support` | tickets (metadados mínimos) |

Acesso excepcional a dados de titular: tabela `support_access_grants` exige ticket, motivo, prazo e **aprovador diferente** do beneficiário (constraint). Não existe "entrar como paciente" (nem endpoint nem tela).

## MFA

Obrigatório (`roles.requires_mfa`) para qualquer vínculo profissional e para equipe da plataforma. Sessão sem segundo fator é barrada em `requireAuth`/`requireUser` (exceto rotas de login/MFA). Recuperação por códigos de uso único; reset administrativo exige motivo e é auditado. Recuperar senha não contorna o MFA.

## Ciclo de vida de vínculo

Remover membro: `status='removed'` (histórico mantido), escopos apagados, **todas as sessões do usuário revogadas**, vínculo profissional inativado se for o último papel de médico. Não é possível remover o último gestor. Convites: expiram em 7 dias, hash no banco, aceite exige e-mail verificado idêntico ao do convite.

## Acesso a agendamentos

- Paciente: só consultas em que é solicitante ou paciente vinculado (verificado).
- Equipe: `authorizeOrg(...).allows(médico, local)`; fora do escopo devolve **404** (não revela existência).
- Disponibilidade entre organizações expõe apenas livre/ocupado.

## Testes que sustentam esta matriz

`tests/etapa1-foundation.test.ts` (MFA, convite, AC04), `tests/etapa3-scheduling.test.ts` (AC03/AC05: IDs adulterados, org cruzada, paciente alheio, secretária sem cobrança/exportação), `tests/etapa4-commercial.test.ts` (AC22, métricas/admin negados a paciente).
