# Relatório Final de Homologação E2E — Projeto Beta v3.1 (RC1)

**Projeto:** Projeto Beta — Controle Financeiro Individual e Compartilhado v3.1 (RC1)  
**Repositório:** `kenielcalixton/Projeto-Beta-Consolidado-Controle-Individual-e-Compartilhado`  
**Branch de Homologação:** `homologation/rc1-e2e` (criada sobre o estado limpo de `b08b9bd`)  
**Commit Base:** `b08b9bda84195b90a831e0ffa7f5debf82a1a465` (`fix(rc1): corrigir convites (sha256, situação A/B e e-mail), livro-razão geral e livro-razão do cartão`)  
**Ambiente:** 100% Local — Firebase Emulator Suite (`demo-projeto-beta-v3`) + Vite Dev Server (`http://127.0.0.1:3000`) + Chromium Real via Playwright  
**Status Final:** **APROVADO PARA RC1** (todos os fluxos E2E multiusuário, sondas diretas de segurança, auditoria responsiva e suítes automatizadas aprovados sem falhas após correção de 7 defeitos comprovados).

---

## 1. Fase Zero — Diagnóstico Inicial e Integridade do Ambiente

- **Repositório conectado:** `kenielcalixton/Projeto-Beta-Consolidado-Controle-Individual-e-Compartilhado` (`/home/antigravity/kenielcalixton/Projeto-Beta-Consolidado-Controle-Individual-e-Compartilhado`).
- **Branch original / HEAD recuperado:** `main` no commit `b08b9bda84195b90a831e0ffa7f5debf82a1a465`.
- **Histórico verificado (últimos 10 commits):**
  - `b08b9bd` — `fix(rc1): corrigir convites (sha256, situação A/B e e-mail), livro-razão geral e livro-razão do cartão`
  - `c09b985` — `fix(rc1): unificar extrato, seletores visuais, rateio avulso, estorno, convite por token e aquisições em tempo real`
  - `73e5a4d` — `fix(rc1): corrigir extrato, formulário universal e criação atômica de espaços`
  - `fb65bae` — `fix(rc1): consolidar segurança, fluxos financeiros v3.1, aquisições e tema escuro`
  - `a1b5a43` — `feat(ui): consolidar interface canônica v3, tema escuro e isolamento de múltiplos espaços`
  - `a1260c0` — `fix(ui): corrigir sobreposição do menu flutuante na rolagem da página`
  - `2574154` — `--`
  - `db25ac1` — `feat(rc1): complete frontend integration, 2-step custody return, restitution reversal, seed script and two-user emulator suite`
  - `854b84d` — `feat(rc): complete Release Candidate implementation for security, business rules, UI integration and E2E tests (FINAL-CORRECTION-FINANCE-V3.1-RC-01)`
  - `5f640f8` — `feat(phase9-10): implement decoupled recurrences & installment contracts, complete e2e homologation suite (MASTER-EXECUTION-FINANCE-V3.1-FINAL-01 - Etapas 5 e 6)`
- **Estado de trabalho inicial:** Árvore limpa (`git status` sem alterações não commitadas ou untracked). Branch `homologation/rc1-e2e` criada de forma não destrutiva para condução da homologação.
- **Restrições operacionais cumpridas:**
  - Nenhuma alteração em `.firebaserc` (`"default": "demo-projeto-beta-v3"` preservado).
  - Nenhum deploy, migração ou escrita no Firebase remoto.
  - Emuladores locais exclusivos em `127.0.0.1`: Auth (`9099`), Firestore (`8080`), Functions (`5001`), Storage (`9199`) e Emulator UI (`4000`).
  - Nenhuma regra de segurança em `firestore.rules` foi removida ou enfraquecida.

---

## 2. Cenário E2E Real no Navegador (Chromium + Playwright)

Foram executadas **4 suítes E2E em Chromium headless real** com **3 contextos de navegador isolados simultâneos** (`ctxAlice`, `ctxBob`, `ctxCarol` — sem reutilização de sessão nem troca simulada de usuário):

- **Alice:** `alice.rc1@exemplo.com`
- **Bob:** `bob.rc1@exemplo.com`
- **Carol:** `carol.rc1@exemplo.com`

### 2.1 Cobertura Executada e Aprovada (Suites 1 a 4)

| Suíte E2E | Escopo Funcional Homologado na Interface Real | Resultado | Erros de Página (`pageerror`) | Avisos de Permissão (`consoleWarnings`) |
| --- | --- | --- | --- | --- |
| `e2e-suite1.mjs` | **Seções 5, 6.1, 6.8:** Erros de login, criação de conta + verificação via OOB do Auth Emulator, edição de perfil (`displayName`) com persistência após reload e novo login, criação de `"Residência Alice & Bob"` e `"Viagem com Carol"`, convite Situação A (Bob) e Situação B (Carol pré-cadastro + bloqueio pré-verificação + aceite após verificação), alternância e isolamento estrito entre os 3 usuários. | **PASS** (exit `0`) | `0` | `0` |
| `e2e-suite2.mjs` | **Seções 6.2, 6.3, 6.4, 6.5, 6.6:** CRUD/arquivamento/desarquivamento de contas bancárias, criação/edição de cartão de crédito (`Cartão Nubank RC1`, limite R\$ 6.000,00), distinção visual/contábil entre Livro Razão de Cartão e Conta Bancária, categoria customizada (`Veterinário RC1` com ícone e cor hex) persistida após reload, Formulário Universal unificado (receita, despesa, edição, amortização, estorno, cancelamento), compras à vista e parceladas no cartão, projeção de faturas futuras, pagamento de fatura sem duplicidade no Extrato, filtros e isolamento no Livro Razão Geral. | **PASS** (exit `0`) | `0` | `0` |
| `e2e-suite3.mjs` | **Seções 6.7, 6.8, 6.9:** Ciclo completo de despesa compartilhada (`Aluguel RC1`, R\$ 1.000,00, split 50/50), declaração de pagamento, rejeição com histórico append-only, re-declaração e aprovação creditando conta de Alice, revogação imutável de aprovação criando obrigação formal de restituição, confirmação e estorno compensatório de restituição, reembolso parcial de fornecedor recalculando cotas (R\$ 500,00 → R\$ 400,00), Rateio Avulso com contraproposta (`Jantar Avulso`) mantendo status pendente após aceite, custódia em 2 etapas (`Fundo Compras Casa`) com devolução parcial e confirmação em 2 passos, convite por link aberto SHA-256 + revogação, arquivamento/desarquivamento de espaço com bloqueio de escrita, dissolução com prazo de 30 dias + decisão de autor + cancelamento + reabertura após cancelamento, remoção de ex-participante preservando visão histórica sanitizada. | **PASS** (exit `0`) | `0` | `0` |
| `e2e-suite4.mjs` | **Seções 6.11, 6.12, 7, 9:** Lista individual `Recorrente` (`Estoque → A Comprar → Carrinho → Conferido` com soma de estoque `1 + 2 = 3 un` e reversão), lista `Objetivo` (cotação, depósito 100% com auto-liberação e relatório final de economia), conversão de `Desejo` para `Objetivo`, sincronização de lista compartilhada com Bob e isolamento contra Carol; regras recorrentes (criação, replay idempotente no mês inicial, materialização do mês seguinte, pausar, reativar, cancelar) e parcelamento em andamento (`4/6 → 6/6` + inspeção + cancelamento antecipado); 11 sondas REST diretas contra Firestore Emulator (todas `403`); auditoria responsiva Dark UI sem overflow horizontal em `1440×900`, `768×1024` e `390×844`. | **PASS** (exit `0`) | `0` | `0` |

> **Observação sobre diagnósticos do navegador:** Todas as 4 suítes finalizaram com `pageErrors = 0`, `consoleWarnings = 0` e nenhuma falha de permissão Firestore/Functions. As únicas entradas em `consoleErrors` foram bloqueios esperados do proxy local às CDNs externas (`fonts.googleapis.com` / `unpkg.com` via `ERR_CERT_AUTHORITY_INVALID`) e o `404` de `/favicon.ico` (além do `400` esperado no teste negativo de senha inválida na Suite 1).

---

## 3. Defeitos Comprovados e Corrigidos

### Defeito #1 — Falha de permissão em `countSpaceRecords` ao abrir modal de dissolução (`acquisition_lists`)
- **Evidência:** Erro `FirebaseError: false for 'list' @ L643` capturado via console do navegador ao acionar o fluxo de dissolução de espaço compartilhado.
- **Causa raiz:** A consulta em [`spaceDissolutionService.ts`](../../src/services/spaceDissolutionService.ts#L146-L150) filtrava `acquisition_lists` apenas por `where('spaceId', '==', spaceId)` sem incluir `where('scopeType', '==', 'shared')`, não satisfazendo a cláusula estrita da regra de segurança em `firestore.rules`.
- **Correção:** Adicionado `where('scopeType', '==', 'shared')` à `listQuery` em [`spaceDissolutionService.ts`](../../src/services/spaceDissolutionService.ts#L146-L150).
- **Validação:** Reexecutada Suite 3 (`Defect #1 countSpaceRecords warning present: false`, `consoleWarnings=0`).

### Defeito #2 — Compras no cartão de crédito não consumiam limite nem entravam na fatura quando criadas sem marcar "Já foi Paga"
- **Evidência:** Ao registrar despesa de cartão pelo Formulário Universal sem alternar manualmente o botão de pagamento, o lançamento permanecia `pending` sem consumir limite do cartão nem gerar `charge` na fatura.
- **Causa raiz:** `UniversalTransactionModal.tsx`, `personalTransactionService.ts` e `functions/index.js` tratavam cartão de crédito como despesa pendente comum caso `status !== 'paid'`. Adicionalmente, o ramo `else if (requestedStatus === 'paid')` em `functions/index.js` precisava rejeitar transações pagas sem `accountId` válido.
- **Correção:**
  - [`functions/index.js`](../../functions/index.js#L2230-L2359): Promoção autoritativa para `effectiveStatus = 'paid'` quando a conta de origem for `credit` (não cancelada e não receita), gerando lançamento de fatura/consumo de limite atomicamente, além de exigir `accountId` válido quando `requestedStatus === 'paid'`.
  - [`src/services/personalTransactionService.ts`](../../src/services/personalTransactionService.ts#L193-L309): Espelhamento consistente no modo demo e validação prévia de conta/cartão arquivado.
  - [`src/components/UniversalTransactionModal.tsx`](../../src/components/UniversalTransactionModal.tsx#L348-L363): Exibição clara do estado `"Faturada no Cartão (Lançada na Fatura)"` ocultando o botão redundante `"Já foi Paga"` para despesas individuais no cartão.
- **Validação:** Suite 2 verificou compras à vista e parceladas no `Cartão Nubank RC1`, redução de limite disponível, projeção em faturas futuras e pagamento de fatura sem duplicar despesa no Extrato.

### Defeito #3 — Sub-abas de Finanças Compartilhadas exibiam dados defasados ao alternar entre Despesas/Custódia/Restituições
- **Evidência:** Após confirmar/rejeitar/revogar em uma aba e navegar entre sub-abas de `SharedFinanceSectionV3`, o estado anterior podia persistir até um refresh manual.
- **Causa raiz:** `useEffect` em [`SharedFinanceSectionV3.tsx`](../../src/components/spaces/SharedFinanceSectionV3.tsx#L232-L237) não recarregava silenciosamente ao trocar `activeTab`.
- **Correção:** Inclusão de `activeTab` na dependência com `loadFinanceData({ silent: !isInitialContextLoad })` para atualização silenciosa sem flicker.

### Defeito #4 — Colisão de `idempotencyKey` ao re-declarar pagamento rejeitado ou re-confirmar restituição estornada
- **Evidência:** Após rejeição de uma declaração de pagamento ou estorno de uma confirmação de restituição, uma nova tentativa para o mesmo item colidia com a chave anterior e retornava replay idempotente da tentativa antiga.
- **Causa raiz:** Ausência de chave de idempotência única por tentativa na UI de [`SharedFinanceSectionV3.tsx`](../../src/components/spaces/SharedFinanceSectionV3.tsx#L239-L412).
- **Correção:** Geração de chaves únicas por tentativa (`declAttemptKey`, `restitutionAttemptKey`) via `createUiAttemptKey` ao abrir cada modal/ação.
- **Validação:** Suite 3 validou rejeição → nova declaração → aprovação, e confirmação de restituição → estorno → saldo restaurado.

### Defeito #5 — Race condition em tempo real em `subscribeToListItems` após criar lista (`evaluation error at L658:24`)
- **Evidência:** Ao criar uma nova lista de aquisições, o listener `subscribeToListItems(listId)` disparava antes de o documento pai existir no servidor, resultando em `PERMISSION_DENIED` (`evaluation error at L658:24 for 'list' @ L658`) porque a regra consulta `get(/acquisition_lists/${listId})`.
- **Causa raiz:** `subscribeToIndividualLists` e `subscribeToSharedLists` em [`acquisitionsFirebase.ts`](../../src/services/acquisitionsFirebase.ts#L336-L368) emitiam snapshots otimistas locais (`snapshot.metadata.hasPendingWrites === true`) enquanto o `setDoc` ainda estava em trânsito.
- **Correção:** Ignorar snapshots locais pendentes com `if (snapshot.metadata.hasPendingWrites) return;` em ambas as assinaturas.
- **Validação:** Suites 3 e 4 executadas com `consoleWarnings=0` ao criar listas individuais e compartilhadas e adicionar itens em tempo real.

### Defeito #6 — Criador impedido pelas regras do Firestore de reabrir dissolução após cancelar solicitação anterior
- **Evidência:** Na Suite 3, após cancelar uma dissolução em `Viagem com Carol` e tentar iniciar uma nova dissolução pelo botão da UI, a operação falhou com `PERMISSION_DENIED ... false for 'update' @ L375`.
- **Causa raiz:** `initiateSpaceDissolution` grava em `spaces/{spaceId}/dissolution/request` via `setDoc`. Quando já existe um documento com `requestStatus == 'cancelled_by_creator'` ou `'auto_cancelled_timeout'`, o `setDoc` executa `update` nas regras, e [`firestore.rules`](../../firestore.rules#L375-L390) só permitia atualizar para `cancelled_by_creator` ou atualizar `authorDestinations`.
- **Correção:** Adicionado ramo restrito exclusivamente ao criador (`isSpaceCreator(spaceId)`) em `match /dissolution/{docId}` permitindo transição **somente** de `cancelled_by_creator` / `auto_cancelled_timeout` para `pending_author_responses` com `initiatedByUid == request.auth.uid`, `spaceId == spaceId` e `id == 'request'`.
- **Regressão garantida:** Adicionado **Teste #12** em [`src/services/firestore.rules.test.ts`](../../src/services/firestore.rules.test.ts#L1545-L1633) validando bloqueio para não-criadores, bloqueio de spoofing de `initiatedByUid`, bloqueio de sobrescrita enquanto `pending_author_responses` está ativa e permissão legítima do criador após cancelamento.

### Defeito #7 — Validação HTML5 bloqueando depósitos de metas (`min="1" step="10"`) e recorte horizontal de botões nos cards Kanban
- **Evidência:** Capturado na Suite 4 via screenshot real do Chromium (`Please enter a valid value. The two nearest valid values are 991 and 1001.`) ao digitar `1000` em `#deposit-amount-input`, além de recorte à direita do botão `Repor Despensa` dentro da coluna `04. Conferido` em `1440px`.
- **Causa raiz:** Em [`WorkspaceBoardView.tsx`](../../src/components/acquisitions/WorkspaceBoardView.tsx), `#deposit-amount-input` possuía `min="1" step="10"` (aceitando apenas `1, 11, 21, ..., 991, 1001`), `#item-target-amount` possuía `step="10"`, `#ws-board-edit-budget` possuía `step="50"`, e o rodapé dos cards (`L1201`) não possuía `flex-wrap`.
- **Correção:** Ajustados os inputs monetários para `step="0.01"` (com `min="0.01"` ou `min="0"`) e adicionado `flex-wrap` no container de ações do rodapé dos cards em [`WorkspaceBoardView.tsx`](../../src/components/acquisitions/WorkspaceBoardView.tsx#L1201).
- **Validação:** Suite 4 concluiu integralmente o fluxo de depósitos, quitação da meta, relatório final e inspeção visual em desktop, tablet e mobile.

---

## 4. Auditoria Direta de Segurança (REST API do Firestore Emulator)

Executadas 11 sondas diretas em tempo real na Suite 4 contra `http://127.0.0.1:8080` sobre os dados criados na homologação:
1. Leitura não autenticada em `accounts/{id}` → **HTTP 403**
2. Leitura não autenticada em `spaces/{id}` → **HTTP 403**
3. Bob tentando ler conta pessoal de Alice (`accounts/{id}`) → **HTTP 403**
4. Bob tentando ler lista individual de Alice (`acquisition_lists/{id}`) → **HTTP 403**
5. Carol tentando ler espaço `Residência Alice & Bob` → **HTTP 403**
6. Carol tentando listar `shared_expenses` de `Residência Alice & Bob` → **HTTP 403**
7. Cliente Alice tentando escrita direta em `accounts/{id}/movements` → **HTTP 403**
8. Cliente Alice tentando escrita direta em `payment_approvals` → **HTTP 403**
9. Cliente Alice tentando escrita direta em `approval_revocations` → **HTTP 403**
10. Cliente Alice tentando escrita direta em `spaces/{id}/audit_events` → **HTTP 403**
11. Cliente Alice tentando adulterar `projectedBalanceCents` via `PATCH` em `accounts/{id}` → **HTTP 403**

---

## 5. Auditoria Visual e Responsiva (Tema Escuro)

Verificados sem transbordamento horizontal (`scrollWidth <= innerWidth`) nos viewports **`1440×900` (Desktop)**, **`768×1024` (Tablet)** e **`390×844` (Mobile)** nas abas `Contas & Cartões`, `Extrato`, `Espaços`, `Listas` e no modal `UniversalTransactionModal`:

- `desktop` (`1440×900`): `scrollWidth = 1440 <= 1440` em todas as telas e modal.
- `tablet` (`768×1024`): `scrollWidth = 768 <= 768` em todas as telas e modal.
- `mobile` (`390×844`): `scrollWidth = 390 <= 390` em todas as telas e modal.
- Screenshots inspecionados visualmente:
  - `suite4-desktop-modal.png`, `suite4-tablet-modal.png`, `suite4-mobile-modal.png`
  - `suite4-desktop-extrato.png`, `suite4-tablet-extrato.png`, `suite4-mobile-extrato.png`

---

## 6. Resultados Consolidados das Suítes Automatizadas (Pós-Correções)

| Comando | Resultado | Contagem Exata |
| --- | --- | --- |
| `npm run typecheck` | **PASS** (exit `0`) | `0` erros TypeScript |
| `npm run build` | **PASS** (exit `0`) | Build Vite de produção concluído sem erros |
| `npm test` | **PASS** (exit `0`) | **175** testes aprovados / **14** suítes / `0` falhas |
| `npm run test:rules` | **PASS** (exit `0`) | **13** testes aprovados (inclui novo Teste #12 de reabertura de dissolução) / `0` falhas |
| `npm run test:scenario` | **PASS** (exit `0`) | **8** testes aprovados (cenário completo Alice & Bob com emuladores Auth/Firestore/Storage/Functions) / `0` falhas |
| `npm run test:emulator` | **PASS** (exit `0`) | **81** testes aprovados (**62** no lote 1 + **19** no lote 2, cobrindo `firestore.rules`, `phase34`–`phase9`, `extratoUniversalForm`, `spaceCreationFlow`, `rc1Audit`, `invitesAndLedgers`) / `0` falhas |

---

## 7. Arquivos Modificados no Repositório

1. [`firestore.rules`](../../firestore.rules) — Regra restrita de reabertura de dissolução apenas pelo criador após cancelamento.
2. [`functions/index.js`](../../functions/index.js) — Tratamento autoritativo de cartão de crédito (`effectiveStatus = 'paid'`) e exigência de conta em pagamentos diretos.
3. [`src/services/personalTransactionService.ts`](../../src/services/personalTransactionService.ts) — Espelhamento consistente do tratamento de cartão de crédito em modo demo e validação de conta arquivada.
4. [`src/services/spaceDissolutionService.ts`](../../src/services/spaceDissolutionService.ts) — Adição de `where('scopeType', '==', 'shared')` em `countSpaceRecords`.
5. [`src/services/acquisitionsFirebase.ts`](../../src/services/acquisitionsFirebase.ts) — Filtro `if (snapshot.metadata.hasPendingWrites) return;` para evitar corrida em `subscribeToListItems`.
6. [`src/components/UniversalTransactionModal.tsx`](../../src/components/UniversalTransactionModal.tsx) — Estado explícito `"Faturada no Cartão"` para despesas no cartão sem toggle enganoso.
7. [`src/components/spaces/SharedFinanceSectionV3.tsx`](../../src/components/spaces/SharedFinanceSectionV3.tsx) — Recarga silenciosa ao trocar sub-aba e `idempotencyKey` única por tentativa em declarações e restituições.
8. [`src/components/acquisitions/WorkspaceBoardView.tsx`](../../src/components/acquisitions/WorkspaceBoardView.tsx) — `step="0.01"` em inputs monetários (`#deposit-amount-input`, `#item-target-amount`, `#ws-board-edit-budget`) e `flex-wrap` no rodapé dos cards Kanban.
9. [`src/services/firestore.rules.test.ts`](../../src/services/firestore.rules.test.ts) — Teste #12 cobrindo cancelamento e reabertura de dissolução.
10. [`docs/reports/RC1-E2E-HOMOLOGATION-REPORT.md`](./RC1-E2E-HOMOLOGATION-REPORT.md) — Este relatório final de homologação.

---

## 8. Veredito Final RC1

**HOMOLOGAÇÃO RC1 APROVADA.**  
Todos os requisitos funcionais multiusuário, isolamento estrito entre 3 usuários e múltiplos espaços, regras contábeis append-only, integridade das `firestore.rules`, responsividade em tema escuro e suítes E2E/emulador/unitárias foram validados em execução real após as correções finais, sem pendências bloqueadoras.
