# Manual administrativo

Acesso: equipe da plataforma entra em `/entrar` com **segundo fator obrigatório**. O menu "Administração" só aparece a quem tem papel ativo; cada tela também verifica a permissão no servidor.

## Credenciamento (`/admin/credenciamento`, papel `moderator`)
1. Abra a fila; confira nome, CRM/UF e especialidades/RQE enviados.
2. **Consulte manualmente a fonte oficial** (portal do conselho) — o sistema não faz verificação online nem a simula.
3. Aprovar exige: fonte, inscrição verificada, situação, data da consulta e próxima revisão. Ficam gravadas com seu usuário.
4. "Pedir ajustes"/"Rejeitar" com observação. Mudanças de CRM/RQE/nome/especialidade voltam à fila e **não alteram a publicação** até aprovação.
5. Suspensão (API `POST /admin/practitioners/{id}/suspend`, motivo obrigatório): some da busca, bloqueia novas marcações, libera reservas temporárias, marca consultas futuras para contato (`needs_followup`) e emite `PractitionerSuspended` — ninguém troca o médico sem concordância do paciente.
6. Rotina de reverificação periódica (`next_review_at`) ainda **não** gera alertas (backlog).

## Assinaturas (`/admin/assinaturas`, `platform_admin`)
Planos são hipóteses editáveis por nova versão (não afeta assinaturas existentes). Pedidos de arrependimento/restituição aparecem com protocolo: **decisão humana** conforme contrato e lei (não há decisão automática). Inadimplência: carência → restrição de novas marcações; dados e consultas existentes são preservados.

## Privacidade (`/admin/privacidade`, `security_admin`/`platform_admin`)
Cada pedido tem protocolo, prazo (por tipo; valores são placeholders), responsável e **decisão fundamentada obrigatória**. Eliminação: registre a decisão (com categorias retidas), garanta que não há consultas futuras ativas, execute. O sistema remove identificação, sessões, MFA e conteúdo livre e mantém registros administrativos sem identificação direta. Após restaurar backup, reaplicar eliminações.

## Incidentes (`/admin/incidentes`) e Auditoria (`/admin/auditoria`)
Registre incidente com datas de detecção e ciência; o relógio de comunicação é calculado (3 dias úteis, sem feriados). A auditoria é só leitura; consultar também é auditado.

## Documentos e módulos (`/admin/documentos`, `/admin/configuracoes`)
Documentos aparecem como **minutas**; publicar exige aprovador humano registrado (o sistema não publica sozinho). Módulos bloqueados aparecem desligados e sem implementação. **Não existe "entrar como paciente"**; acesso excepcional exige grant com ticket, motivo, prazo e outro aprovador.

## Suporte (`/admin/suporte`)
Somente metadados (protocolo, assunto, situação). Se um paciente enviar dado clínico indevidamente: restrinja o acesso, trate conforme a política de retenção e oriente o titular (procedimento formal: backlog).
