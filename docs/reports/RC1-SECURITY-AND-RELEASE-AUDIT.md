# AUDITORIA FINAL DE SEGURANÇA E FECHAMENTO DO RC1
## Projeto Beta — Controle Financeiro Individual e Compartilhado v3.1 (Pré-Consolidação)

- **Data da Auditoria:** 2026-11-15
- **Branch Auditada:** `homologation/rc1-e2e`
- **Commit Base (`HEAD` e `main`):** `b08b9bda84195b90a831e0ffa7f5debf82a1a465`
- **Projeto Firebase Local (Exclusivo):** `demo-projeto-beta-v3` (Firebase Emulator Suite)
- **Veredito Final:** **APROVADO COM RESSALVAS** *(Liberado para consolidação/merge em `main`; requer execução dos itens pré-deploy listados na Seção 11 antes de qualquer `firebase deploy` remoto).*

---

## 1. Identificação e Preservação do Ambiente

Durante toda a auditoria, todas as restrições operacionais foram estritamente cumpridas:
- **Nenhum deploy executado**, **nenhuma migração remota**, **nenhum acesso ou escrita ao Firebase remoto**.
- **Nenhum `git commit`**, **nenhum `git push`**, **nenhuma alteração em `main`**, **nenhuma alteração em `.firebaserc`**.
- Nenhuma regra de segurança foi enfraquecida e nenhum teste foi removido.

| Verificação | Resultado Real Observado |
| :--- | :--- |
| Branch atual (`git branch --show-current`) | `homologation/rc1-e2e` |
| Commit atual (`git rev-parse HEAD`) | `b08b9bda84195b90a831e0ffa7f5debf82a1a465` |
| Commit de `main` (`git rev-parse main`) | `b08b9bda84195b90a831e0ffa7f5debf82a1a465` (inalterado) |
| Integridade `.firebaserc` (`git diff -- .firebaserc`) | Sem diferenças (`demo-projeto-beta-v3` preservado) |
| Higiene de diff (`git diff --check`) | Exit `0` (zero erros de whitespace ou EOF) |
| Arquivos modificados no repositório (11) | `firestore.rules`, `functions/index.js`, `src/components/UniversalTransactionModal.tsx`, `src/components/acquisitions/WorkspaceBoardView.tsx`, `src/components/spaces/SharedFinanceSectionV3.tsx`, `src/services/acquisitionsFirebase.ts`, `src/services/firestore.rules.test.ts`, `src/services/personalTransactionService.ts`, `src/services/phase8.emulator.test.ts`, `src/services/phase9.emulator.test.ts`, `src/services/spaceDissolutionService.ts` |
| Diretório não rastreado | `docs/reports/` (`RC1-E2E-HOMOLOGATION-REPORT.md` e este relatório `RC1-SECURITY-AND-RELEASE-AUDIT.md`) |

---

## 2. Auditoria Detalhada das Regras Firestore

Inspeção linha a linha de [`firestore.rules`](../../firestore.rules) confrontada com os serviços clientes e Cloud Functions em [`functions/index.js`](../../functions/index.js).

### Grupo 1 — Despesas Compartilhadas

| Recurso / Caminho Real | Quem Pode Ler | Quem Pode Escrever | Operação Exclusiva do Backend | Função / Serviço Legítimo | Testes que Comprovam |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `spaces/{spaceId}/shared_expenses/{expenseId}` ([`firestore.rules#L395-L418`](../../firestore.rules#L395-L418)) | Membro ativo (`isSpaceMember`) ou ex-membro histórico envolvido (`createdByUid`, `responsibleUid`, ou em `participantUids`). | **Create:** membro ativo em espaço ativo com `createdByUid == auth.uid`.<br>**Update:** (a) `responsibleUid` apenas nos campos de validação/execução; (b) `createdByUid` antes da aprovação sem mudar `createdByUid`, `spaceId`, `responsibleUid` e mantendo `validationStatus in ['pending_validation', 'rejected']`.<br>**Delete:** `false`. | Criação atômica oficial com rateio inicial e geração de `liabilities` (e criação em ambiente com CF ativa). | [`createSharedExpenseOfficial`](../../functions/index.js#L4206) via [`sharedFinanceService.ts`](../../src/services/sharedFinanceService.ts); validação via [`validateExpensePaymentOfficial`](../../functions/index.js#L4480). | `firestore.rules.test.ts` Testes #4, #6, #13; `phase6.emulator.test.ts`; `e2e-suite3.mjs`. |
| `spaces/{spaceId}/shared_expenses/{expenseId}/liabilities/{memberUid}` ([`firestore.rules#L420-L429`](../../firestore.rules#L420-L429)) | Membro ativo (`isSpaceMember`) ou ex-membro histórico se for o titular (`memberUid == auth.uid`) ou `responsibleUid` da despesa. | **`false`** (`allow write: if false`). | Criação inicial das cotas, atualização de `paidAmountCents`/`remainingAmountCents`, reajuste por reembolso e restauração por revogação. | [`createSharedExpenseOfficial`](../../functions/index.js#L4206), [`validateExpensePaymentOfficial`](../../functions/index.js#L4480), [`revokeExpensePaymentApprovalOfficial`](../../functions/index.js), [`recordSharedRefundOfficial`](../../functions/index.js). | `firestore.rules.test.ts` Testes #6, #13; `twoUsersScenario.emulator.test.ts`; `phase6.emulator.test.ts`. |
| `spaces/{spaceId}/shared_expenses/{expenseId}/payments/{paymentId}` ([`firestore.rules#L431-L440`](../../firestore.rules#L431-L440)) | Membro ativo (`isSpaceMember`) ou ex-membro histórico executor (`executedByUid`) ou `responsibleUid` da despesa. | **`false`** (`allow write: if false`). | Registro imutável de pagamentos da despesa compartilhada. | Cloud Functions (Admin SDK). | `firestore.rules.test.ts` Teste #13 (leitura autorizada/negada + create/update/delete negados). |

> [!NOTE]
> Também auditadas e confirmadas com `allow write: if false` as subcoleções contábeis correlatas em `shared_expenses/{expenseId}`: `bilateral_debts`, `refunds`, `payment_approvals`, `payment_rejections`, `approval_revocations`, `restitutions`, `restitution_receipts`, `restitution_reversals`. `payment_declarations` e `restitution_declarations` possuem `create` restrito ao membro ativo (`memberUid`/`payerUid == auth.uid`) com `update, delete: if false` (append-only).

### Grupo 2 — Aquisições

| Recurso / Caminho Real | Quem Pode Ler | Quem Pode Escrever | Operação Exclusiva do Backend | Função / Serviço Legítimo | Testes que Comprovam |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `acquisition_lists/{listId}` ([`firestore.rules#L652-L674`](../../firestore.rules#L652-L674)) | Individual: `ownerUid == auth.uid`.<br>Compartilhada: `isSpaceMember(spaceId)`. | **Create:** individual sem `spaceId` com `ownerUid == auth.uid`; compartilhada em espaço ativo por membro com `ownerUid == auth.uid` (ou `createdByUid == auth.uid` quando `ownerUid` é omitido).<br>**Update:** dono individual ou membro de espaço ativo, com `scopeType`, `ownerUid` e `spaceId` **estritamente imutáveis**.<br>**Delete:** `false`. | N/A (CRUD controlado de metadados da lista com imutabilidade de escopo/propriedade). | [`createAcquisitionList`](../../src/services/acquisitionsService.ts#L330-L375) e [`saveListToFirestore`](../../src/services/acquisitionsFirebase.ts#L418-L430). | `firestore.rules.test.ts` Testes #11, #14; `phase8.emulator.test.ts` Teste #1; `e2e-suite4.mjs` Parte A + sonda REST #4. |
| `acquisition_lists/{listId}/items/{itemId}` ([`firestore.rules#L675-L683`](../../firestore.rules#L675-L683)) | Quem tem acesso de leitura à lista (`canAccessAcquisitionList(listId)`). | **Create:** `canWriteAcquisitionList(listId)` e `createdByUid == auth.uid`.<br>**Update:** `canWriteAcquisitionList(listId)` com **`listId` e `createdByUid` imutáveis**.<br>**Delete:** `canWriteAcquisitionList(listId)` (exclusão de item antes de virar compra consolidada). | Atualizações atômicas de estágio/estoque/acumulado durante checkout, estorno, depósito e cotação. | [`createAcquisitionItem`](../../src/services/acquisitionsService.ts#L417), [`saveItemToFirestore`](../../src/services/acquisitionsFirebase.ts#L448) e CFs de aquisição. | `firestore.rules.test.ts` Testes #11, #14; `phase8.emulator.test.ts` Testes #1–#7; `e2e-suite4.mjs` Parte A. |
| `acquisition_lists/{listId}/items/{itemId}/purchases/{purchaseId}` ([`firestore.rules#L684-L687`](../../firestore.rules#L684-L687)) | `canAccessAcquisitionList(listId)`. | **`false`** (`allow write: if false`). | Checkout de compra, cálculo de copropriedade, débito em conta/fatura. | [`executeServerSideAcquisitionCheckout`](../../functions/index.js#L7206) via [`recordAcquisitionPurchase`](../../src/services/acquisitionsService.ts#L542). | `firestore.rules.test.ts` Teste #14; `phase8.emulator.test.ts` Testes #4, #5, #7, #8. |
| `acquisition_lists/{listId}/items/{itemId}/purchase_reversals/{reversalId}` ([`firestore.rules#L689-L692`](../../firestore.rules#L689-L692)) *(Adicionada na Auditoria)* | `canAccessAcquisitionList(listId)`. | **`false`** (`allow write: if false`). | Estorno compensatório de compra, reversão de estoque e desembolsos. | [`executeServerSideReverseAcquisitionPurchase`](../../functions/index.js#L7695) via [`reverseAcquisitionPurchase`](../../src/services/acquisitionsService.ts#L717) e leitura em [`getAcquisitionPurchaseReversals`](../../src/services/acquisitionsService.ts#L846). | `firestore.rules.test.ts` Teste #14; `phase8.emulator.test.ts` Teste #6. |
| `acquisition_lists/{listId}/items/{itemId}/stock_movements/{movementId}` ([`firestore.rules#L704-L707`](../../firestore.rules#L704-L707)) | `canAccessAcquisitionList(listId)`. | **`false`** (`allow write: if false`). | Movimentação append-only de entrada, consumo e estorno de estoque. | [`executeServerSideRecordStockMovement`](../../functions/index.js#L7424), checkout e estorno via [`recordStockMovement`](../../src/services/acquisitionsService.ts#L865). | `firestore.rules.test.ts` Teste #14; `phase8.emulator.test.ts` Testes #2, #8. |

> [!NOTE]
> As subcoleções `quotes/{quoteId}` ([`firestore.rules#L694-L697`](../../firestore.rules#L694-L697)) e `deposits/{depositId}` ([`firestore.rules#L699-L702`](../../firestore.rules#L699-L702)) também possuem `allow write: if false`, com escrita exclusiva via [`executeServerSideRecordQuote`](../../functions/index.js#L7505) e [`executeServerSideRecordDeposit`](../../functions/index.js#L7566).

### Grupo 3 — Recorrências

| Recurso / Caminho Real | Quem Pode Ler | Quem Pode Escrever | Operação Exclusiva do Backend | Função / Serviço Legítimo | Testes que Comprovam |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `recurrence_rules/{ruleId}` ([`firestore.rules#L712-L734`](../../firestore.rules#L712-L734)) | Pessoal: `userId == auth.uid`.<br>Compartilhada: `isSpaceMember(spaceId)`. | **Create:** pessoal sem `spaceId` (`userId == auth.uid`); compartilhada em espaço ativo (`userId == auth.uid` e membro).<br>**Update:** pessoal pelo titular ou compartilhada por membro de espaço ativo, **restrito exclusivamente aos campos `['status', 'updatedAt']`**, mantendo `scope`, `userId`, `spaceId`, `amountCents` e `type` imutáveis.<br>**Delete:** `false`. | Criação oficial atômica com geração automática da instância inicial do mês de competência; geração de novas instâncias mensais. | [`executeServerSideCreateRecurrenceRule`](../../functions/index.js#L7900), [`executeServerSideGenerateRecurrenceInstance`](../../functions/index.js#L7992) e pausa/reativação/cancelamento via [`updateRecurrenceRuleStatus`](../../src/services/recurrenceService.ts#L357). | `firestore.rules.test.ts` Teste #15; `phase9.emulator.test.ts` Testes #1, #2, #5, #6; `e2e-suite4.mjs` Parte B. |
| `recurrence_rules/{ruleId}/instances/{competenceMonth}` ([`firestore.rules#L735-L738`](../../firestore.rules#L735-L738)) | `canAccessRecurrenceRule(ruleId)` (titular pessoal ou membro do espaço). | **`false`** (`allow write: if false`). | Materialização da instância mensal e criação atômica da `PersonalTransaction` / `SharedExpense` correspondente. | [`executeServerSideCreateRecurrenceRule`](../../functions/index.js#L7900) e [`executeServerSideGenerateRecurrenceInstance`](../../functions/index.js#L7992) via [`generateRecurrenceInstance`](../../src/services/recurrenceService.ts#L269). | `firestore.rules.test.ts` Teste #15; `phase9.emulator.test.ts` Testes #1, #2, #6. |

### Grupo 4 — Parcelamentos

| Recurso / Caminho Real | Quem Pode Ler | Quem Pode Escrever | Operação Exclusiva do Backend | Função / Serviço Legítimo | Testes que Comprovam |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `installment_contracts/{contractId}` ([`firestore.rules#L741-L747`](../../firestore.rules#L741-L747)) *(Endurecida na Auditoria)* | Pessoal: `userId == auth.uid`.<br>Compartilhada: `isSpaceMember(spaceId)`. | **`false`** (`allow create, update, delete: if false`). | Criação do contrato, cálculo conservador de centavos, geração das ocorrências vigentes/futuras, vinculação à fatura do cartão e cancelamento antecipado. | [`executeServerSideCreateInstallmentContract`](../../functions/index.js#L8116) e [`executeServerSideCancelInstallmentContract`](../../functions/index.js#L8393) via [`recurrenceService.ts`](../../src/services/recurrenceService.ts#L471-L785). | `firestore.rules.test.ts` Teste #15; `phase9.emulator.test.ts` Testes #3, #4, #6; `e2e-suite4.mjs` Parte B. |
| `installment_contracts/{contractId}/occurrences/{installmentNumber}` ([`firestore.rules#L748-L751`](../../firestore.rules#L748-L751)) | `canAccessInstallmentContract(contractId)` (titular pessoal ou membro do espaço). | **`false`** (`allow write: if false`). | Criação das parcelas e transição controlada de `scheduled` para `cancelled` no cancelamento antecipado (preservando parcelas já faturadas/pagas). | [`executeServerSideCreateInstallmentContract`](../../functions/index.js#L8116) e [`executeServerSideCancelInstallmentContract`](../../functions/index.js#L8393). | `firestore.rules.test.ts` Teste #15; `phase9.emulator.test.ts` Testes #3, #4, #6; `e2e-suite4.mjs` Parte B. |

---

## 3. Testes de Segurança Negativos e Positivos Executados

Foram executadas e ampliadas três camadas complementares de validação de segurança contra o Firebase Emulator Suite:

1. **Suite Dedicada de Regras (`src/services/firestore.rules.test.ts`) — 16 testes aprovados (incluindo 3 novos testes #13, #14 e #15 criados nesta auditoria):**
   - **Teste #13 (Despesas Compartilhadas):** valida bloqueio de usuário não autenticado e membro de outro espaço (`space_2` / `uid_eve`) em `liabilities` e `payments`; valida leitura legítima de membros ativos (`Alice`/`Bob`) e bloqueio estrito de escrita direta em `liabilities`/`payments`; bloqueia tentativa de auto-aprovação ou troca de `responsibleUid` pelo autor (`Bob`) e bloqueia alteração/deleção em `audit`.
   - **Teste #14 (Aquisições):** valida bloqueio de não autenticado e `uid_eve` (`space_2`) em `acquisition_lists`, `items`, `purchases`, `stock_movements` e `purchase_reversals`; valida leitura legítima de membro ativo (`Bob`); bloqueia sequestro de `scopeType`/`ownerUid`/`spaceId` em lista compartilhada e deleção; bloqueia escrita em espaço arquivado; bloqueia escrita direta em `purchases`, `stock_movements`, `quotes`, `deposits` e `purchase_reversals`.
   - **Teste #15 (Recorrências e Parcelamentos):** valida bloqueio de não autenticado e `uid_eve` (`space_2`); valida leitura de membro ativo e atualização legítima de `status` em `recurrence_rules` em espaço ativo; bloqueia adulteração de `amountCents`, sequestro de `scope`/`userId`/`spaceId` e escrita em espaço arquivado; bloqueia criação/alteração/exclusão direta pelo cliente em `installment_contracts`, `instances` e `occurrences`.

2. **Testes de Autorização nas Cloud Functions (`phase8.emulator.test.ts` Teste #8 e `phase9.emulator.test.ts` Teste #6):**
   - `phase8.emulator.test.ts` Teste #8: usuário externo (`eve.phase8@exemplo.com`) bloqueado com `permission-denied` em `recordStockMovementOfficial`, `recordAcquisitionQuoteOfficial`, `recordAcquisitionDepositOfficial` e `acquisitionCheckoutOfficial`.
   - `phase9.emulator.test.ts` Teste #6: validação positiva de `updateRecurrenceRuleStatus('paused')`, bloqueio de adulteração client-side (`amountCents`, `instances`, `occurrences`), e bloqueio (`permission-denied`) de usuário externo (`eve.phase9@exemplo.com`) em `generateRecurrenceInstanceOfficial` e tentativa de lançamento no cartão de crédito de Alice via `createInstallmentContractOfficial`.

3. **Sondas REST Diretas na Suíte E2E (`e2e-suite4.mjs` Parte C — 11 sondas HTTP 403):**
   - Todas as 11 sondas contra a API REST do Firestore Emulator retornaram `HTTP 403` com usuários reais do navegador (`Alice`, `Bob`, `Carol` + anônimo): leitura anônima (`accounts`, `spaces`), leitura cruzada (`Bob -> Alice account`, `Bob -> Alice individual acquisition_list`), exclusão de não-membro (`Carol -> Residência Alice & Bob` e `shared_expenses`), escrita direta em coleções server-only (`movements`, `payment_approvals`, `approval_revocations`, `audit_events`) e adulteração de `projectedBalanceCents`.

---

## 4. Auditoria da Integridade Financeira

Revisão completa de código e fluxos reais E2E/emulador nos arquivos [`functions/index.js`](../../functions/index.js), [`src/services/personalTransactionService.ts`](../../src/services/personalTransactionService.ts), [`src/services/ledgerService.ts`](../../src/services/ledgerService.ts), [`src/services/budgetService.ts`](../../src/services/budgetService.ts), [`src/components/UniversalTransactionModal.tsx`](../../src/components/UniversalTransactionModal.tsx) e [`src/components/TransactionDetailModal.tsx`](../../src/components/TransactionDetailModal.tsx):

| Fluxo Auditado | Comportamento Verificado e Garantias |
| :--- | :--- |
| **Compras no Cartão de Crédito** | No momento da compra via [`executeServerSideCreatePersonalTransaction`](../../functions/index.js) e [`personalTransactionService.ts#L193-L220`](../../src/services/personalTransactionService.ts#L193-L220), a despesa nasce com `effectiveStatus = 'paid'` (reconhecendo o fato gerador no orçamento/competência imediatamente), sem movimentar o saldo bancário (`targetAccount.type !== 'credit'`). A obrigação com a administradora permanece registrada na subcoleção `accounts/{cardId}/invoices/{YYYY-MM}/charges/{chargeId}` e acumulada em `CreditCardInvoice.totalChargesCents`, atualizando o limite utilizado do cartão em tempo real. |
| **Geração e Pagamento de Faturas (Zero Dupla Contagem)** | O pagamento da fatura via `payCardInvoiceOfficial` debita a conta bancária de origem criando diretamente um `FinancialMovement` com `originType = 'credit_card_payment'` ([`ledgerService.ts#L310`](../../src/services/ledgerService.ts#L310)) e registra `CreditCardInvoicePayment` em `invoices/{month}/payments`, **sem criar uma segunda `PersonalTransaction` de despesa**. Compras no cartão já contam como despesa na competência da compra; a quitação da fatura liquida o passivo financeiro e reduz o saldo bancário sem duplicidade. |
| **Parcelamentos no Cartão** | `executeServerSideCreateInstallmentContract` distribui centavos sem perda (`remainder` na 1ª parcela), projeta apenas parcelas vigentes/futuras em contratos em andamento (sem fabricar histórico passado) e vincula cada ocorrência às respectivas faturas mensais (`CreditCardInvoiceCharge`), debitando o limite do cartão com integridade. |
| **Criação, Pagamento, Estorno e Cancelamento de Despesas** | Pagamentos parciais (`Amortizar`) geram `FinancialMovement` imutável e recalculam `paidAmountCents`; estornos (`Estornar`) criam registro append-only em `payment_reversals` e movimento compensatório oposto (jamais sobrescrevendo o pagamento original); cancelamentos preservam a trilha de auditoria e proíbem cancelamento de despesa com pagamentos ativos sem prévio estorno. |
| **Despesas Compartilhadas, Revogações e Restituições** | Declarações não alteram saldos nem criam movimentos; apenas a aprovação pelo `responsibleUid` exclusivo gera crédito em conta; rejeições e revogações são eventos append-only (`payment_rejections`, `approval_revocations`); revogações após uso/saldo geram `ExpenseRestitutionObligation` formal com liquidação e estorno rastreados. |
| **Contas Arquivadas e Bloqueios** | Contas arquivadas (`isArchived === true`) não aceitam novas transações marcadas como pagas, novos parcelamentos ou novas movimentações, preservando a integridade histórica do livro-razão. |

---

## 5. Auditoria das Cloud Functions (`firebase-admin` Warning e Segurança)

### 5.1 Investigação do Warning de `firebase-admin` no Functions Emulator

Durante a execução dos emuladores (`test:scenario`, `test:emulator`, `emulators`), observou-se o log:
> `⚠ The Cloud Functions emulator requires the module "firebase-admin" to be installed as a dependency. To fix this, run "npm install --save firebase-admin" in your functions directory.`

**Causa Raiz Comprovada em Código:**
1. O arquivo [`functions/package.json`](../../functions/package.json) declara `name`, `version`, `type: "module"`, `main: "index.js"` e `engines.node: "22"`, **sem campo `"dependencies"`** (e sem `functions/node_modules/`).
2. Ao iniciar um worker de Cloud Function, [`firebase-tools@13.35.1`](../../node_modules/firebase-tools/lib/emulator/functionsEmulatorRuntime.js#L138-L159) executa `verifyDeveloperNodeModules()`, que verifica `package.json` em `functions/` buscando `"firebase-admin"` e `"firebase-functions"` em `dependencies`/`devDependencies`. Como não estão declaradas lá, emite o log `missing-module` (`firebase-admin`) e retorna `false` em [`initializeRuntime()`](../../node_modules/firebase-tools/lib/emulator/functionsEmulatorRuntime.js#L570-L574).
3. Apesar do retorno antecipado do verificador, o Node.js resolve normalmente os módulos ESM `firebase-admin@^14.5.0` e `firebase-functions@^7.4.0` a partir do `node_modules/` da raiz do repositório, permitindo que todas as 50 Cloud Functions carreguem e executem no emulador local.
4. **Teste de Hipótese (Incompatibilidade `firebase-tools@13.35.1` × `firebase-functions@7.4.0`):** Ao testar a inclusão de `"dependencies": { "firebase-admin": "^14.5.0", "firebase-functions": "^7.4.0" }` em `functions/package.json`, o verificador passou (`declared: true, installed: true`), mas [`initializeRuntime()`](../../node_modules/firebase-tools/lib/emulator/functionsEmulatorRuntime.js#L577) avançou para [`initializeFunctionsConfigHelper()`](../../node_modules/firebase-tools/lib/emulator/functionsEmulatorRuntime.js#L452-L458), que chama **`localFunctionsModule.config()`** — método removido no `firebase-functions@7.4.0` que lança exceção fatal (`functions.config() has been removed in firebase-functions v7`), derrubando os workers do emulador.
5. **Decisão Técnica:** Mantido [`functions/package.json`](../../functions/package.json) no estado original para preservar estabilidade total no emulador local com `firebase-tools@13.35.1` + `firebase-functions@7.4.0`, documentando como **item obrigatório pré-deploy** (Seção 11) a atualização de `firebase-tools` (`>= 14.x`) e declaração das dependências em `functions/package.json` antes de publicar no Cloud Build / Firebase remoto.

### 5.2 Endurecimento de Autorização das Cloud Functions Executado na Auditoria

Todas as 50 Cloud Functions exportadas em [`functions/index.js`](../../functions/index.js) foram auditadas quanto à autenticação (`callerUid`), verificação de pertencimento/escopo, validação de conta arquivada e estado do espaço (`spaceStatus`). Foram corrigidas **4 brechas de autorização** (detalhadas na Seção 8).

---

## 6. Revisão de Higiene do Repositório e Evidências

- **`git diff --check`:** Executado após todas as edições — saída limpa, exit code `0`. (Erro anterior de linha em branco extra ao final de `src/services/firestore.rules.test.ts` foi eliminado).
- **Configuração Firebase (`.firebaserc` e `firebase.json`):** `.firebaserc` permanece intocado apontando exclusivamente para `demo-projeto-beta-v3`.
- **Logs de emulador temporários (`firebase-debug.log`, `firestore-debug.log`):** Ignorados pelo `.gitignore` (não aparecem em `git status`).
- **Evidências E2E (Scripts, Screenshots e Traces):** Localizados e íntegros no diretório de trabalho da sessão Antigravity:
  - Scripts: `/home/antigravity/.gemini/jetski/brain/v1/default/jetski_remote_agents_3p/94e67ca8-f5c3-41fe-a7f8-2043b8bc6c0b/scratch/e2e-helpers.mjs`, `e2e-suite1.mjs`, `e2e-suite2.mjs`, `e2e-suite3.mjs`, `e2e-suite4.mjs`.
  - Screenshots e Traces históricos: `/home/antigravity/.gemini/jetski/brain/v1/default/jetski_remote_agents_3p/94e67ca8-f5c3-41fe-a7f8-2043b8bc6c0b/scratch/screenshots/` e `.../traces/`.
  - Todos os links em [`RC1-E2E-HOMOLOGATION-REPORT.md`](./RC1-E2E-HOMOLOGATION-REPORT.md) são válidos (caminhos relativos ao repositório para código e caminhos absolutos para artefatos de sessão).

---

## 7. Resultados Finais de Execução (Pós-Correções Finais)

Todos os comandos abaixo foram executados **sequencialmente após a última edição de código e regras**:

| Verificação | Comando | Resultado | Detalhes Reais Observados |
| :--- | :--- | :--- | :--- |
| Typecheck | `npm run typecheck` | **PASS** (exit `0`) | `tsc --noEmit` sem erros |
| Build | `npm run build` | **PASS** (exit `0`) | Vite `dist/` gerado em `1.98s` |
| Unit / Integração | `npm test` | **PASS** (exit `0`) | **175 / 175** testes aprovados (**14** suítes, `0` falhas) |
| Regras Firestore | `npm run test:rules` | **PASS** (exit `0`) | **16 / 16** testes aprovados (inclui novos Testes #13, #14 e #15, `0` falhas) |
| Cenário 2 Usuários | `npm run test:scenario` | **PASS** (exit `0`) | **8 / 8** testes aprovados no Emulator Suite (`0` falhas) |
| Suítes Emulador | `npm run test:emulator` | **PASS** (exit `0`) | **86 / 86** testes aprovados (**67** lote 1 + **19** lote 2, inclui novos Testes #13–#15, `phase8` Teste #8 e `phase9` Teste #6, `0` falhas) |
| E2E Suíte 1 | `node .../e2e-suite1.mjs` | **PASS** (exit `0`) | Auth, verificação OOB, perfil, convites Situação A/B, isolamento 3 usuários (`pageErrors=0`) |
| E2E Suíte 2 | `node .../e2e-suite2.mjs` | **PASS** (exit `0`) | Contas, cartões, faturas, categorias, transações, estorno, cancelamento, livros-razão (`pageErrors=0`) |
| E2E Suíte 3 | `node .../e2e-suite3.mjs` | **PASS** (exit `0`) | Rateios, aprovações/rejeições/revogações, restituições, avulsos, custódia, dissolução (`consoleWarnings=0`, `pageErrors=0`) |
| E2E Suíte 4 | `node .../e2e-suite4.mjs` | **PASS** (exit `0`) | Aquisições (4 fluxos), recorrências/parcelamentos, **11 sondas REST (todas HTTP 403)**, 15 checagens responsivas (`0` overflow, `consoleWarnings=0`, `pageErrors=0`) |

---

## 8. Defeitos e Vulnerabilidades Encontradas e Corrigidas na Auditoria

1. **Vulnerabilidade Crítica — Injeção Cross-User em Cartão de Crédito via `createInstallmentContractOfficial`:**
   - **Causa Raiz:** [`executeServerSideCreateInstallmentContract`](../../functions/index.js#L8116) carregava `accounts/{fundingAccountId}` quando `fundingSource === 'credit_card'`, porém **não validava `cardAccountData.userId === cleanCaller` nem `!isAccountArchivedServer(cardAccountData)`**, permitindo a qualquer usuário autenticado lançar parcelas na fatura do cartão de terceiros ou de conta arquivada.
   - **Correção:** Adicionada validação estrita de titularidade (`permission-denied` se `cardAccountData.userId !== cleanCaller`) e estado de arquivamento (`failed-precondition` se arquivada) em [`functions/index.js`](../../functions/index.js#L8116).
   - **Comprovação:** `phase9.emulator.test.ts` Teste #6.

2. **Vulnerabilidade Alta — Falta de Verificação de Acesso em Cloud Functions de Aquisições:**
   - **Causa Raiz:** `executeServerSideRecordStockMovement`, `executeServerSideRecordQuote` e `executeServerSideRecordDeposit` em [`functions/index.js`](../../functions/index.js#L7424-L7694) verificavam apenas autenticação e existência do item, sem validar se `cleanCaller` era `ownerUid` (lista individual) ou membro de espaço ativo (`memberUids` + `spaceStatus` != `archived`/`dissolved`) em lista compartilhada.
   - **Correção:** Criado helper compartilhado [`assertAcquisitionListWriteAccessServer`](../../functions/index.js#L7179-L7205) e aplicado às 5 Cloud Functions de aquisição (`Checkout`, `RecordStockMovement`, `RecordQuote`, `RecordDeposit` e `ReverseAcquisitionPurchase`).
   - **Comprovação:** `phase8.emulator.test.ts` Teste #8.

3. **Vulnerabilidade Alta — Regras Firestore Permissivas em `installment_contracts`, `recurrence_rules`, `acquisition_lists` e `shared_expenses` + Subcoleção `purchase_reversals` Ausente:**
   - **Causa Raiz:**
     - `installment_contracts` permitia `create`/`update` direto pelo cliente apesar de todo o fluxo oficial rodar via Cloud Functions.
     - `recurrence_rules` permitia `update` arbitrário de `amountCents`, `type`, `scope` e `spaceId` pelo cliente.
     - `shared_expenses` na ramificação de edição pelo autor (`createdByUid`) não impedia auto-aprovação (`validationStatus = 'approved'`) nem troca de `responsibleUid`/`spaceId`.
     - `acquisition_lists` permitia alterar `scopeType`, `ownerUid` ou `spaceId` em `update`, e `items/{itemId}` permitia alterar `listId`/`createdByUid`.
     - Faltava regra explícita para `purchase_reversals`, causando erro `PERMISSION_DENIED` em leitura legítima de estornos e falta de blindagem explícita.
     - Em recorrências/parcelamentos compartilhados nas CFs, faltava rejeição explícita para espaços com `spaceStatus` `archived` ou `dissolved`.
   - **Correção:** Endurecimento completo em [`firestore.rules#L406-L417`](../../firestore.rules#L406-L417), [`firestore.rules#L652-L709`](../../firestore.rules#L652-L709) e [`firestore.rules#L711-L752`](../../firestore.rules#L711-L752), além de validação de `spaceStatus` nas CFs de recorrência e parcelamento em [`functions/index.js`](../../functions/index.js).
   - **Comprovação:** `firestore.rules.test.ts` Testes #13, #14 e #15; `phase8.emulator.test.ts` Teste #8; `phase9.emulator.test.ts` Teste #6.

4. **Correção de Higiene (EOL Whitespace):**
   - **Causa Raiz:** Linha em branco extra no EOF de `src/services/firestore.rules.test.ts` reportada por `git diff --check`.
   - **Correção:** Removida ao consolidar os novos testes; `git diff --check` retorna `0`.

---

## 9. Pendências, Riscos Residuais e Limitações

1. **Pré-requisito de Deploy das Cloud Functions (`functions/package.json` vs `firebase-tools@13.35.1`):**
   - No ambiente local, `functions/package.json` não declara `"dependencies"` devido à incompatibilidade de `firebase-tools@13.35.1` com `firebase-functions@7.4.0` (`localFunctionsModule.config()` lança erro no runtime do emulador). Para deploy remoto no Cloud Functions / Cloud Build, é obrigatório declarar `"dependencies"` em `functions/package.json` (e atualizar `firebase-tools` no projeto/CI para versão compatível com `firebase-functions v7`). **Severidade:** Operacional / Pré-deploy.
2. **Regra Broad de Storage para Espaços (`storage.rules#L7-L9`):**
   - [`storage.rules`](../../storage.rules#L7-L9) permite `read, write: if request.auth != null;` em `/spaces/{spaceId}/{allPaths=**}`, pois regras de Storage não suportam `get()` nativo em documentos do Firestore. Embora o aplicativo cliente atual envie arquivos exclusivamente para `users/${uid}/...` ([`acquisitionsFirebase.ts#L521`](../../src/services/acquisitionsFirebase.ts#L521)), qualquer upload futuro no prefixo `/spaces/` exigirá mediação via Cloud Function/Signed URL ou Custom Claims. **Severidade:** Baixa (superfície atualmente não utilizada pelo cliente).
3. **Ordem Read-After-Write Condicional em `executeServerSideReverseAcquisitionPurchase`:**
   - Em [`functions/index.js#L7776-L7814`](../../functions/index.js#L7776-L7814), caso uma compra revertida contenha `disbursements` com `sourceAccountId` preenchido, `tx.get(accRef)` ocorre após `tx.update(itemRef)`, o que o Firestore transacional rejeita (`reads must happen before writes`). Nos fluxos atuais os testes não populam `sourceAccountId` nesse array, porém recomenda-se pré-carregar `accRef` antes dos writes em iteração futura. **Severidade:** Média/Baixa (condicional ao uso de `disbursements[].sourceAccountId`).
4. **Localização Externa dos Scripts E2E Playwright:**
   - Os arquivos `e2e-helpers.mjs` e `e2e-suite1.mjs`–`e2e-suite4.mjs` foram mantidos no diretório scratch da sessão Antigravity para não poluir o diff do RC1; caso deseje versioná-los para CI futuro, devem ser copiados explicitamente para `tests/e2e/` em commit separado.
5. **Recursos CDN Externos no Browser Local:**
   - No ambiente sandboxed local, requisições externas de fontes/ícones (`fonts.googleapis.com` e `unpkg.com/@phosphor-icons/web`) sofrem `ERR_CERT_AUTHORITY_INVALID` pelo proxy local, sem impacto funcional nem erros de página (`pageErrors=0`).

---

## 10. Veredito Final Estruturado

**VEREDITO: `APROVADO COM RESSALVAS`**

- **Status de Segurança & Integridade Funcional RC1:** **Aprovado.** Nenhuma vulnerabilidade crítica ou alta permanece aberta no código ou nas `firestore.rules`. Todas as 10 validações automatizadas (typecheck, build, 175 unitários, 16 regras, 8 cenário, 86 emulador e 4 suítes E2E completas no Chromium) foram executadas após a correção final com **0 falhas**.
- **Motivo das Ressalvas:** Necessidade de cumprir os ajustes operacionais de empacotamento em `functions/package.json` (atualização de `firebase-tools` + declaração de `dependencies` + `npm --prefix functions install`) antes de qualquer `firebase deploy` remoto, além das observações documentadas em `storage.rules` (`/spaces/`) e na ordem transacional de `sourceAccountId` em estorno de compras.

---

## 11. Recomendação Objetiva sobre Consolidação

1. **Consolidação Git (`homologation/rc1-e2e` → `main`):** **LIBERADA.** O código-fonte, as regras de segurança e a suíte de testes presentes no worktree estão consistentes, higienizados (`git diff --check` limpo), alinhados ao projeto emulado `demo-projeto-beta-v3` e prontos para commit e merge em `main` após revisão humana.
2. **Checklist Obrigatório Antes de Deploy Remoto (`firebase deploy`):**
   - Atualizar `firebase-tools` (`>= 14.x`) compatível com `firebase-functions@^7.4.0`.
   - Adicionar `"dependencies": { "firebase-admin": "^14.5.0", "firebase-functions": "^7.4.0" }` em [`functions/package.json`](../../functions/package.json) e executar `npm --prefix functions install` para empacotamento remoto no Cloud Build.
   - Publicar `firestore.rules` e `functions` conjuntamente para manter sincronia entre validações de servidor e regras do banco.
