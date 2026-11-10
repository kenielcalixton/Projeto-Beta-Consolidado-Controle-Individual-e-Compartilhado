# Especificação da Arquitetura de Dados Definitiva
## Financeiro Individual, Espaços Compartilhados, Rateios Avulsos, Transferências e Listas de Aquisição

**Documento Normativo de Engenharia de Dados**  
**Status:** Proposta de Arquitetura Submetida para Aprovação do Usuário  
**Autorização de Implementação:** NÃO AUTORIZADA (Documento Estritamente Descritivo e Arquitetural)  
**Data:** 09 de Novembro de 2026  
**Auditoria de Código-Fonte:** `src/types/finance.ts`, `src/types/acquisitions.ts`, `src/utils/financeEngine.ts`, `src/utils/stateMachine.ts`, `src/App.tsx`.

---

## 1. Diagnóstico da Arquitetura Atual e Limitações Inspecionadas

A auditoria no código revelou que o sistema atual possui três subsistemas com níveis heterogêneos de maturidade, conectados por condicionais frágeis em memória:

```
ARQUITETURA ATUAL (MONOLÍTICA E ACOPLADA EM COLEÇÃO ÚNICA)
Coleção Global Firestore: 'transactions'
├── Se spaceId === '' && splits.length === 0  --> Financeiro Individual
├── Se spaceId === '' && splits.length > 0    --> Rateio Avulso (Mesmo documento!)
├── Se spaceId !== ''                         --> Espaço Compartilhado
└── Se paidByEmail === 'space_cash'           --> Uso de Caixa Comum (Sem entidade de caixa)

Coleções Paralelas de Listas: 'workspaces', 'lists', 'items'
└── Duplicadas conceitualmente com 'spaces' e desvinculadas das transações financeiras
```

### Limitações Críticas Evidenciadas no Código:
1. **Sobrecarga da Entidade `Transaction` (`src/types/finance.ts:68-102`):**
   - Um único documento acumula despesa individual, receita, despesa coletiva, rateio avulso e liquidação sintética (`description.startsWith('Reembolso Livro-Razão:')`).
   - Depende de condicionais frágeis de string (`spaceId ?`, `paidByEmail === 'space_cash'`).
2. **Falta de Isolamento Físico e Acoplamento a E-mail (`src/App.tsx:605-608`):**
   - A consulta única `where('participantEmails', 'array-contains', email)` busca tudo junto na mesma coleção. Se o e-mail mudar, o histórico é perdido.
3. **Ausência de Entidade para Pagamentos e Liquidação de Faturas (`src/App.tsx:825-865`):**
   - Não há entidade para amortizações parciais. A função `handlePayInvoice` ignora `_sourceCheckingId`, marcando cartões como pagos sem debitar contas bancárias.
4. **Ausência de Entidade de Transferência e Custódia:**
   - `SettlementTransfer` é apenas uma interface efêmera em memória (`financeEngine.ts:505`). Não existe entidade para adiantamentos ou devoluções.
5. **Desconexão Bidirecional entre Listas e Finanças (`src/App.tsx:2584-2596`):**
   - O checkout da lista abre o modal de despesa, mas executa `setPresetSpaceId(undefined)` e não grava o `itemId` na transação nem o `transactionId` no item da lista.

---

## 2. Mapa Estrutural de Entidades: Mantidas, Adaptadas, Criadas e Descontinuadas

| Entidade | Ação Arquitetural | Justificativa Técnica Baseada no Código |
| :--- | :--- | :--- |
| **`UserProfile`** | **MANTIDA** | Já desacoplada e estável em `users/{uid}` com `uid`, `email`, `name` (`src/types/finance.ts:129-134`). |
| **`Account`** | **ADAPTADA** | Mantém `checking` e `credit`, mas ganha subcoleções privadas para metadados bancários e faturas reais. |
| **`Category`** | **MANTIDA** | Sistema global e flexível de categorias pessoais e compartilhadas (`src/types/finance.ts:19-27`). |
| **`TaxonomyGroup` / `TaxonomyCategory`** | **MANTIDA** | Catálogo maduro de grupos e categorias para listas de compras (`src/types/acquisitions.ts:29-42`). |
| **`Space`** | **ADAPTADA** | Unificada: absorve o módulo de aquisições. Substitui `participantEmails` por `memberUids` e governa permissões. |
| **`Workspace` (de Aquisições)** | **DESCONTINUADA** | Duplicação desnecessária (`src/types/acquisitions.ts:15-27`). Listas passarão a pertencer a um `userId` ou a um `spaceId`. |
| **`Transaction` (Monolítica)** | **DESCONTINUADA** | Substituída pela segregação estrita entre `PersonalTransaction`, `SharedExpense` e `AdhocSplitExpense`. |
| **`PersonalTransaction`** | **CRIADA** | Entidade exclusiva para receitas, despesas e transferências puramente individuais (`spaceId === ''`). |
| **`SharedExpense`** | **CRIADA** | Obrigação financeira de consumo pertencente a um Espaço Compartilhado. |
| **`ExpenseLiability`** | **CRIADA** | Cota de responsabilidade bruta de cada participante na despesa compartilhada. |
| **`ExpensePayment`** | **CRIADA** | Pagamento efetivo com segregação entre executor operacional (`executedByUid`) e financiador real (`economicFunderUid`). |
| **`BilateralDebtLedger`** | **CRIADA** | Visão projetada determinística das dívidas bilaterais geradas quando um membro financia a cota de outro. |
| **`AdhocSplitExpense`** | **CRIADA** | Despesa pessoal com rateio avulso para terceiros fora de espaços compartilhados. |
| **`AdhocSplitObligation`** | **CRIADA** | Obrigação independente gerada no financeiro do participante convidado para o rateio avulso. |
| **`AdhocReimbursement`** | **CRIADA** | Reembolso vinculado que credita o autor da despesa avulsa sem inflar sua receita comum. |
| **`TransferRecord` / `TransferEvent`** | **CRIADA** | Entidade de transferências entre pessoas, adiantamentos com custódia, utilizações e devoluções parciais. |
| **`CreditCardInvoice` / `InvoiceCarryOver`** | **CRIADA** | Entidades reais para faturas de cartão, pagamento real com débito bancário e transporte de saldo rolado. |
| **`SharedResourcePool` / `ResourceMovement`** | **CRIADA** | Saldo contábil coletivo de recursos livres do espaço, com histórico de aportes e baixas auditadas. |
| **`AcquisitionList`** | **ADAPTADA** | Deixa de pertencer a `workspaceId` e passa a pertencer a `ownerUid` (Individual) ou `spaceId` (Compartilhada). |
| **`AcquisitionItem`** | **ADAPTADA** | Recebe `createdByUid` obrigatório, vínculo bidirecional com a despesa financeira (`linkedExpenseId`) e propriedade. |
| **`ProductPurchase`** | **ADAPTADA** | Subcoleção de histórico de compras ganha `buyerUid` e `paymentMethod` para rastreabilidade contábil. |

---

## 3. Modelo Proposto de Entidades e Dicionário de Campos

Todos os valores monetários são obrigatoriamente padronizados em **centavos inteiros** (`number` inteiro positivo), eliminando qualquer risco de arredondamento por ponto flutuante IEEE 754. Identificadores de usuário utilizam **exclusivamente o `uid` estável do Firebase Auth**.

### 3.1. Núcleo Pessoal e Contas Bancárias

#### `Account` (`accounts/{accountId}`)
- `id`: string (PK)
- `userId`: string (FK `users/{uid}`) [REGRA JÁ APROVADA]
- `name`: string (Ex: "Nubank", "Itaú Corrente")
- `type`: `'checking' | 'credit'` [REGRA JÁ APROVADA]
- `currentBalanceCents`: number (Saldo real em centavos para conta corrente)
- `creditLimitCents`: number (Limite total para cartão de crédito)
- `closingDay`: number (1 a 31)
- `dueDay`: number (1 a 31)
- `color`: string
- `icon`: string
- `isArchived`: boolean [SUGESTÃO TÉCNICA]
- `createdAt`: string (ISO)

#### `PrivatePaymentMetadata` (`accounts/{accountId}/private_payment_metadata/{paymentId}`)
*Isolado fisicamente na subcoleção privada do titular:*
- `paymentId`: string (PK)
- `userId`: string (FK `users/{uid}`) [REGRA JÁ APROVADA]
- `accountId`: string (FK `accounts/{accountId}`)
- `bankName`: string
- `accountType`: `'checking' | 'credit'`
- `receiptStorageUrl`?: string (Recibo confidencial) [REGRA JÁ APROVADA]
- `realBankDebitTimestamp`: string (ISO)

#### `PersonalTransaction` (`users/{userId}/personal_transactions/{txId}`)
- `id`: string (PK)
- `userId`: string (FK `users/{uid}`) [REGRA JÁ APROVADA]
- `description`: string
- `amountCents`: number
- `type`: `'income' | 'expense' | 'internal_transfer'` [SUGESTÃO TÉCNICA]
- `status`: `'pending' | 'paid' | 'overdue'` [REGRA JÁ APROVADA]
- `categoryId`: string
- `accountId`: string (FK `accounts/{accountId}`)
- `competenceDate`: string (YYYY-MM-DD)
- `dueDate`: string (YYYY-MM-DD)
- `paymentDate`?: string (YYYY-MM-DD)
- `invoiceMonth`: string (YYYY-MM)
- `destinationAccountId`?: string (Se `internal_transfer` entre contas próprias) [SUGESTÃO TÉCNICA]
- `originType`: `'manual' | 'shopping_list' | 'installment' | 'recurrence'` [REGRA JÁ APROVADA]
- `originRefId`?: string (FK `items/{itemId}`)
- `createdAt`: string

---

### 3.2. Núcleo de Espaços Compartilhados e Governança

#### `Space` (`spaces/{spaceId}`)
- `id`: string (PK)
- `ownerId`: string (FK `users/{uid}`) [REGRA JÁ APROVADA]
- `name`: string
- `description`: string
- `icon`: string
- `color`: string
- `memberUids`: string[] (Substitui `participantEmails` para consultas de permissão) [REGRA JÁ APROVADA]
- `members`: Array<{
    `uid`: string;
    `name`: string;
    `email`: string;
    `role`: `'owner' | 'admin' | 'member'`;
    `status`: `'active' | 'invited' | 'declined'`;
    `joinedAt`: string;
  }> [REGRA JÁ APROVADA]
- `enabledModules`: Array<`'finance' | 'acquisitions'`> [REGRA JÁ APROVADA]
- `monthlyBudgetCents`?: number
- `createdAt`: string

#### `SharedExpense` (`spaces/{spaceId}/shared_expenses/{expenseId}`)
- `id`: string (PK)
- `spaceId`: string (FK `spaces/{spaceId}`) [REGRA JÁ APROVADA]
- `title`: string
- `description`?: string
- `totalOriginalAmountCents`: number [REGRA JÁ APROVADA]
- `competenceMonth`: string (YYYY-MM)
- `competenceDate`: string (YYYY-MM-DD)
- `dueDate`?: string (YYYY-MM-DD)
- `categoryId`: string
- `categoryName`: string
- `validationStatus`: `'pending_validation' | 'approved' | 'rejected' | 'cancelled'` [REGRA JÁ APROVADA]
- `commitmentStatus`: `'active' | 'closed' | 'cancelled_pre_payment' | 'loss_unrecoverable'` [REGRA JÁ APROVADA]
- `paymentExecutionStatus`: `'unpaid' | 'partially_paid' | 'fully_paid'` [REGRA JÁ APROVADA]
- `createdByUid`: string (FK `users/{uid}`) [REGRA JÁ APROVADA]
- `createdByName`: string
- `validatedByUid`?: string (Obrigatório: validador cruzado, DEVE ser $\neq$ `createdByUid`) [REGRA JÁ APROVADA]
- `validatedAt`?: string
- `rejectionReason`?: string
- `totalPaidToSupplierCents`: number (Calculado exclusivamente de pagamentos aprovados) [REGRA JÁ APROVADA]
- `supplierUnpaidBalanceCents`: number (`totalOriginalAmountCents - totalPaidToSupplierCents`) [REGRA JÁ APROVADA]
- `originType`: `'manual' | 'shopping_list' | 'installment' | 'recurrence'` [REGRA JÁ APROVADA]
- `originRefId`?: string (FK `items/{itemId}`)
- `clientTransactionUuid`: string (Chave de Idempotência) [REGRA JÁ APROVADA]
- `createdAt`: string

#### `ExpenseLiability` (`spaces/{spaceId}/shared_expenses/{expenseId}/liabilities/{memberUid}`)
- `id`: string (PK: `memberUid`)
- `expenseId`: string (FK)
- `spaceId`: string (FK)
- `memberUid`: string (FK `users/{uid}`) [REGRA JÁ APROVADA]
- `memberName`: string
- `assignedShareAmountCents`: number (Cota original bruta) [REGRA JÁ APROVADA]
- `adjustedShareAmountCents`: number (Cota líquida pós-estornos/perdas) [REGRA JÁ APROVADA]
- `splitMethod`: `'equal' | 'percentage' | 'custom_value'` [REGRA JÁ APROVADA]
- `splitRatio`?: number
- `roundingRemainderRank`?: number (Ordem no algoritmo Hamilton/Hare) [REGRA JÁ APROVADA]

#### `ExpensePayment` (`spaces/{spaceId}/shared_expenses/{expenseId}/payments/{paymentId}`)
- `id`: string (PK)
- `expenseId`: string (FK)
- `spaceId`: string (FK)
- `amountCents`: number [REGRA JÁ APROVADA]
- `paymentDate`: string (YYYY-MM-DD)
- `executedByUid`: string (Quem entregou o dinheiro ao fornecedor) [REGRA JÁ APROVADA]
- `executedByName`: string
- `economicFunderUid`: string (De quem era o recurso original) [REGRA JÁ APROVADA]
- `economicFunderName`: string
- `fundingSource`: `'personal_checking' | 'credit_card' | 'free_shared_pool' | 'advance_transfer'` [REGRA JÁ APROVADA]
- `publicPayerLabel`: string (Ex: "Recurso próprio de Keniel") [REGRA JÁ APROVADA]
- `advanceTransferId`?: string (FK `transfers/{transferId}`)
- `validationStatus`: `'pending_validation' | 'approved' | 'rejected'` [REGRA JÁ APROVADA]
- `validatedByUid`?: string (DEVE ser $\neq$ `executedByUid` e $\neq$ `economicFunderUid`) [REGRA JÁ APROVADA]
- `rejectionReason`?: string
- `clientTransactionUuid`: string
- `createdAt`: string

#### `BilateralDebtLedger` (`spaces/{spaceId}/shared_expenses/{expenseId}/bilateral_debts/{debtId}`)
*Visão projetada determinística provada matematicamente pelos pagamentos excedentes:*
- `id`: string (PK: `debtorUid_creditorUid`)
- `expenseId`: string (FK)
- `spaceId`: string (FK)
- `competenceMonth`: string (YYYY-MM)
- `debtorUid`: string (Quem teve sua cota financiada) [REGRA JÁ APROVADA]
- `debtorName`: string
- `creditorUid`: string (Quem financiou além da própria cota) [REGRA JÁ APROVADA]
- `creditorName`: string
- `originalFinancedAmountCents`: number [REGRA JÁ APROVADA]
- `liquidatedCents`: number (Amortizado via `SettlementRecord`) [REGRA JÁ APROVADA]
- `currentRemainingDebtCents`: number (`originalFinancedAmountCents - liquidatedCents`) [REGRA JÁ APROVADA]
- `status`: `'open' | 'partially_settled' | 'fully_settled'` [REGRA JÁ APROVADA]

---

### 3.3. Núcleo de Rateios Avulsos (Despesas Fora de Espaço)

#### `AdhocSplitExpense` (`adhoc_expenses/{expenseId}`)
- `id`: string (PK)
- `ownerUid`: string (Quem pagou a despesa original) [REGRA JÁ APROVADA]
- `ownerName`: string
- `title`: string
- `description`?: string
- `totalAmountCents`: number [REGRA JÁ APROVADA]
- `ownerShareAmountCents`: number (Cota do pagador) [REGRA JÁ APROVADA]
- `totalToReimburseCents`: number (`totalAmountCents - ownerShareAmountCents`) [REGRA JÁ APROVADA]
- `totalReimbursedCents`: number (Soma de reembolsos confirmados) [REGRA JÁ APROVADA]
- `fundingSource`: `'personal_checking' | 'credit_card'` [REGRA JÁ APROVADA]
- `date`: string (YYYY-MM-DD)
- `status`: `'active' | 'fully_reimbursed' | 'cancelled'` [REGRA JÁ APROVADA]
- `participantUids`: string[] (Para indexação e queries) [REGRA JÁ APROVADA]
- `createdAt`: string

#### `AdhocSplitObligation` (`users/{guestUid}/adhoc_obligations/{obligationId}`)
*Gravada diretamente no sub-banco do participante convidado para compor seu passivo individual:*
- `id`: string (PK)
- `adhocExpenseId`: string (FK `adhoc_expenses/{expenseId}`) [REGRA JÁ APROVADA]
- `guestUid`: string (FK `users/{guestUid}`) [REGRA JÁ APROVADA]
- `creditorUid`: string (FK `users/{ownerUid}`) [REGRA JÁ APROVADA]
- `creditorName`: string
- `assignedAmountCents`: number [REGRA JÁ APROVADA]
- `paidAmountCents`: number (Informado pelo devedor) [REGRA JÁ APROVADA]
- `remainingBalanceCents`: number (`assignedAmountCents - paidAmountCents`) [REGRA JÁ APROVADA]
- `status`: `'pending_invite' | 'accepted' | 'rejected' | 'payment_informed' | 'confirmed_cleared'` [REGRA JÁ APROVADA]
- `guestRejectionReason`?: string
- `paymentDeclarationDate`?: string
- `paymentProofUrl`?: string
- `updatedAt`: string

#### `AdhocReimbursement` (`adhoc_expenses/{expenseId}/reimbursements/{reimbursementId}`)
- `id`: string (PK)
- `adhocExpenseId`: string (FK)
- `obligationId`: string (FK)
- `debtorUid`: string (Convidado pagador) [REGRA JÁ APROVADA]
- `creditorUid`: string (Autor da despesa) [REGRA JÁ APROVADA]
- `amountCents`: number [REGRA JÁ APROVADA]
- `paymentDate`: string (YYYY-MM-DD)
- `validationStatus`: `'pending_confirmation' | 'confirmed' | 'rejected'` [REGRA JÁ APROVADA]
- `validatedAt`?: string
- `rejectionReason`?: string
- `destinationAccountId`?: string (Conta onde Keniel recebeu o PIX) [SUGESTÃO TÉCNICA]
- `clientTransactionUuid`: string
- `createdAt`: string

---

### 3.4. Núcleo de Transferências e Adiantamentos (Custódia)

#### `TransferRecord` (`transfers/{transferId}`)
- `id`: string (PK)
- `spaceId`?: string (Opcional: preenchido se for adiantamento dentro de um espaço) [REGRA JÁ APROVADA]
- `senderUid`: string (Quem enviou o dinheiro) [REGRA JÁ APROVADA]
- `senderName`: string
- `custodianUid`: string (Quem recebeu e está com o dinheiro em conta) [REGRA JÁ APROVADA]
- `custodianName`: string
- `initialAmountCents`: number [REGRA JÁ APROVADA]
- `usedAmountCents`: number (Consumido em despesas) [REGRA JÁ APROVADA]
- `returnedAmountCents`: number (Devolvido ao remetente) [REGRA JÁ APROVADA]
- `availableBalanceCents`: number (`initialAmountCents - (usedAmountCents + returnedAmountCents)`) [REGRA JÁ APROVADA]
- `targetExpenseId`?: string (Despesa carimbada, se houver) [REGRA JÁ APROVADA]
- `transferStatus`: `'pending_receipt' | 'custody_active' | 'exhausted' | 'fully_returned'` [REGRA JÁ APROVADA]
- `createdAt`: string

#### `TransferEvent` (`transfers/{transferId}/events/{eventId}`)
*Subcoleção imutável de trilha de auditoria:*
- `id`: string (PK)
- `transferId`: string (FK)
- `eventType`: `'initial_transfer' | 'receipt_confirmed' | 'expense_usage' | 'partial_return' | 'return_confirmed' | 'pool_conversion'` [REGRA JÁ APROVADA]
- `amountCents`: number [REGRA JÁ APROVADA]
- `targetExpenseId`?: string
- `performedByUid`: string [REGRA JÁ APROVADA]
- `justification`?: string
- `clientTransactionUuid`: string
- `timestamp`: string (ISO)

---

### 3.5. Núcleo de Listas de Aquisição (Individual vs. Compartilhada)

#### `AcquisitionList` (`acquisition_lists/{listId}`)
- `id`: string (PK)
- `scopeType`: `'individual' | 'shared'` [REGRA JÁ APROVADA]
- `ownerUid`: string (Preenchido se `individual`, FK `users/{uid}`) [REGRA JÁ APROVADA]
- `spaceId`?: string (Preenchido se `shared`, FK `spaces/{spaceId}`) [REGRA JÁ APROVADA]
- `name`: string
- `description`: string
- `type`: `'recorrente' | 'objetivo' | 'desejo'` [REGRA JÁ APROVADA]
- `memberUids`: string[] (Para indexação e consultas ACL) [REGRA JÁ APROVADA]
- `createdByUid`: string [REGRA JÁ APROVADA]
- `createdAt`: string

#### `AcquisitionItem` (`acquisition_lists/{listId}/items/{itemId}`)
- `id`: string (PK)
- `listId`: string (FK `acquisition_lists/{listId}`)
- `scopeType`: `'individual' | 'shared'` [REGRA JÁ APROVADA]
- `ownerUid`: string (Se individual)
- `spaceId`?: string (Se compartilhada)
- `name`: string
- `groupId`: string (FK `taxonomy/{groupId}`) [REGRA JÁ APROVADA]
- `categoryId`: string (FK `taxonomy/{groupId}/categories/{categoryId}`) [REGRA JÁ APROVADA]
- `listType`: `'recorrente' | 'objetivo' | 'desejo'` [REGRA JÁ APROVADA]
- `stage`: string (Estágio Kanban da máquina de estados) [REGRA JÁ APROVADA]
- `createdByUid`: string [REGRA JÁ APROVADA]
- `notes`?: string
- **Campos Recorrente:** `currentStock`, `minStock`, `unit` (`un`, `kg`, `L`, `pct`, `cx`) [REGRA JÁ APROVADA]
- **Campos Objetivo:** `targetAmountCents`, `savedAmountCents`, `finalPaidAmountCents`, `quotes[]`, `deposits[]` [REGRA JÁ APROVADA]
- **Campos Desejo:** `estimatedPriceCents`, `priority` (`Baixa | Média | Alta`), `inspirationUrl`, `prosAndCons` [REGRA JÁ APROVADA]
- **Vínculo Transacional com Finanças:**
  - `linkedExpenseId`?: string (FK da despesa gerada ao comprar) [REGRA JÁ APROVADA]
  - `linkedExpenseType`?: `'personal' | 'shared'` [REGRA JÁ APROVADA]
- `updatedAt`: string

---

## 4. Diagrama Textual de Relacionamentos e Cardinalidades

```
┌──────────────────┐
│      User        │
│(uid, email, name)│
└────────┬─────────┘
         │
         ├── 1:N ──> Account (checking / credit) ── 1:N ──> PrivatePaymentMetadata
         │
         ├── 1:N ──> PersonalTransaction (Finanças Individuais isoladas)
         │
         ├── 1:N ──> AdhocSplitObligation (Contas a Pagar de Rateios Avulsos)
         │
         ├── 1:N ──> AdhocSplitExpense (Rateios Avulsos criados pelo Usuário)
         │                 │
         │                 └── 1:N ──> AdhocReimbursement (Baixa e Crédito Vinculado)
         │
         ├── 1:N ──> AcquisitionList [Individual] ── 1:N ──> AcquisitionItem
         │
         └── N:M ──> Space (Espaços Compartilhados)
                       │
                       ├── 1:1 ──> SharedResourcePool ── 1:N ──> ResourceMovement
                       │
                       ├── 1:N ──> AcquisitionList [Compartilhada] ── 1:N ──> AcquisitionItem
                       │
                       ├── 1:N ──> TransferRecord (Custódia de Adiantamentos)
                       │                 │
                       │                 └── 1:N ──> TransferEvent (Auditoria imutável)
                       │
                       └── 1:N ──> SharedExpense (Despesas Coletivas)
                                         │
                                         ├── 1:N ──> ExpenseLiability (Cotas brutas)
                                         │
                                         ├── 1:N ──> ExpensePayment (Pagamentos reconhecidos)
                                         │
                                         ├── 1:N ──> BilateralDebtLedger (Visão de créditos)
                                         │                 │
                                         │                 └── 1:N ──< SettlementAllocation
                                         │                                      │
                                         └── 1:N ──> SettlementRecord ──────────┘
```

---

## 5. Fluxos de Gravação e Atualização Atômica

Nenhuma operação multiparticipante utiliza gravações cegas (`setDoc` isolado). Todas as mutações contábeis são executadas via `runTransaction(db, async (tx) => { ... })`:

### 5.1. Fluxo: Compra no Carrinho de Lista Compartilhada $\rightarrow$ Despesa Coletiva
```
[Usuário clica em 'Comprar no Carrinho']
         │
         ▼
[Modal de Checkout do Carrinho captura:]
 • Preço, quantidade, marca, loja, recibo
 • Pagador real (executedByUid e economicFunderUid)
 • Conta ou Fundo utilizado
 • Critério de rateio entre os moradores
         │
         ▼
[Bloco Atômico runTransaction]:
 1. Cria 'SharedExpense' (status: pending_validation, originType: 'shopping_list', originRefId: itemId)
 2. Cria 'ExpenseLiability' para cada participante do rateio
 3. Cria 'ExpensePayment' informando a fonte e pagador
 4. Atualiza o 'AcquisitionItem':
    • stage: 'conferido'
    • currentStock = currentStock + quantidade
    • linkedExpenseId = novo expenseId
    • linkedExpenseType = 'shared'
 5. Grava chave de idempotência na coleção 'idempotency_keys'
         │
         ▼
[Resultado]: Se qualquer escrita falhar, nada é alterado. Não há risco de atualizar estoque sem criar despesa.
```

### 5.2. Fluxo: Rateio Avulso (Keniel R$ 300 / Mariana R$ 100)
```
[1. Keniel cadastra Despesa de R$ 300 com split de R$ 100 para Mariana]
         │
         ▼
[runTransaction]:
 • Cria 'AdhocSplitExpense' (owner: Keniel, total: 300, ownerShare: 200, toReimburse: 100)
 • Cria 'AdhocSplitObligation' na coleção de Mariana (/users/mariana/adhoc_obligations/ob_123)
   (status: 'pending_invite', amount: 100, creditor: Keniel)
         │
         ▼
[2. Mariana acessa Notificações e clica em 'Aceitar Cota']
 • Atualiza sua 'AdhocSplitObligation' para status: 'accepted'
 • O valor de R$ 100 passa a compor oficialmente o passivo individual de Mariana
         │
         ▼
[3. Mariana faz o PIX de R$ 100 e clica em 'Informar Pagamento']
 • Atualiza sua obrigação para status: 'payment_informed' (anexa comprovante)
 • Cria solicitação em 'adhoc_expenses/{id}/reimbursements' (status: 'pending_confirmation')
 • Keniel recebe notificação na Central de Validações
         │
         ▼
[4. Keniel confere o PIX no banco e clica em 'Confirmar Recebimento']
[runTransaction]:
 • Atualiza 'AdhocReimbursement' para status: 'confirmed'
 • Baixa a 'AdhocSplitObligation' de Mariana para status: 'confirmed_cleared'
 • Debita R$ 100 na conta de Mariana e credita R$ 100 na conta de Keniel como REEMBOLSO VINCULADO
 • Prevenção contábil: O sistema NÃO soma R$ 100 como receita comum de Keniel!
   O valor entra como estorno da despesa original, reduzindo o custo líquido de Keniel para R$ 200.
```

---

## 6. Proposta de Segurança e Regras Firestore

O Firestore não oferece segurança por campos dentro de um mesmo documento. Portanto, a regra de ouro desta arquitetura é a **Segregação Física Documental**:

### 6.1. Matriz de Autorização por Coleção

| Coleção Firestore | Quem Pode Ler (`allow read`) | Quem Pode Criar (`allow create`) | Quem Pode Atualizar (`allow update`) | Quem Pode Excluir (`allow delete`) |
| :--- | :--- | :--- | :--- | :--- |
| `accounts/{accId}` | Somente o titular (`request.auth.uid == resource.data.userId`) | Somente o titular | Somente o titular | Proibido se houver transações vinculadas |
| `accounts/{accId}/private_payment_metadata/*` | **Exclusivo do titular** | Somente o titular | Somente o titular | Proibido |
| `users/{uid}/personal_transactions/*` | Somente o titular | Somente o titular | Somente o titular | Somente o titular |
| `users/{uid}/adhoc_obligations/*` | O devedor titular e o credor associado | Criado via transação do credor | Devedor (para aceitar/informar pagamento) e Credor (para confirmar) | Proibido |
| `spaces/{spaceId}` | Membros ativos (`auth.uid in resource.data.memberUids`) | Qualquer usuário autenticado (vira owner) | Somente Owner ou Admin | Somente Owner (se saldo zerado) |
| `spaces/{spaceId}/shared_expenses/*` | Membros do espaço | Membros do espaço (status `pending_validation`) | Autor (se rejeitado/pendente) ou Validador cruzado ($\neq$ autor) | Proibido (soft-delete via status) |
| `transfers/{transferId}` | Remetente e Custodiante | Remetente | Custodiante (para confirmar recebimento) ou Remetente (devolução) | Proibido |
| `acquisition_lists/{listId}` | Titular (se individual) ou Membros do espaço (se compartilhada) | Usuário (individual) ou Membros (compartilhada) | Titular ou Membros do espaço | Titular ou Owner do espaço |

---

## 7. Estratégia de Histórico e Auditoria Imutável (Event-Sourcing Híbrido)

Para garantir que o balanço de qualquer data passada possa ser auditado e reconstruído com precisão forense:

1. **Registros de Origem Imutáveis:**
   - O documento principal `SharedExpense`, `TransferRecord` ou `AdhocSplitExpense` preserva o valor e condições originais da data de criação.
2. **Subcoleções de Eventos de Ajuste:**
   - **Devoluções parciais:** Não reescrevem o valor do adiantamento; gravam um `TransferEvent` (`partial_return`).
   - **Reembolsos do fornecedor:** Gravam um `ExpenseRefundEvent` (`partial_refund` ou `loss_unrecoverable`).
   - **Reversões de liquidação:** Gravam um `SettlementReversionEvent` explicando o motivo do estorno.
3. **Visões Projetadas Recalculáveis:**
   - O documento `BilateralDebtLedger` é uma projeção calculada a partir dos pagamentos aprovados e eventos de liquidação/reversão. Se houver dúvida ou suspeita de descompasso, um comando de conciliação pode recalcular o ledger a partir dos eventos imutáveis com tolerância zero.

---

## 8. Plano de Evolução Não-Destrutiva (Do Legado para o Novo Modelo)

A evolução da base existente para o novo modelo seguirá 4 etapas assíncronas, garantindo que o sistema continue funcionando sem interrupção:

```
[Etapa 1: Deploy das Novas Estruturas e Regras Firestore]
 └── Criação das coleções segregadas sem alterar as telas legadas.
         │
         ▼
[Etapa 2: Script de Migração Não-Destrutivo com Checkpoints]
 ├── Separa transações pessoais (!spaceId) e grava em users/{uid}/personal_transactions.
 ├── Converte despesas de espaço consistentes para spaces/{spaceId}/shared_expenses.
 └── Isola transações com divergência em unresolved_legacy_transactions (Quarentena).
         │
         ▼
[Etapa 3: Habilitação da Central de Validações e Tela de Quarentena]
 └── Usuários conferem dados e resolvem manualmente registros ambíguos.
         │
         ▼
[Etapa 4: Desativação de Leitura da Coleção 'transactions' Legada]
 └── O sistema passa a operar 100% nas novas coleções especializadas.
```

---

## 9. Riscos Técnicos e Decisões Pendentes

### 9.1. Riscos Técnicos Identificados:
1. **Latência em Transações Firestore Multiparticipantes:**
   - *Risco:* Em conexões 3G/4G instáveis, transações que gravam 4 ou 5 documentos podem sofrer timeout.
   - *Mitigação:* Uso do `clientTransactionUuid` para garantir que, caso haja timeout de rede, a tentativa subsequente identifique a chave e não duplique a escrita.
2. **Consultas de Coleção de Grupos (Collection Group Queries):**
   - *Risco:* Buscar despesas de vários espaços pode exigir índices compostos complexos no Firestore.
   - *Mitigação:* As telas são navegadas por contexto (`selectedSpaceId` ou `personal`), eliminando a necessidade de queries globais pesadas.

---

### 9.2. Decisões de Negócio que Dependem Estritamente da Sua Aprovação

Para que esta arquitetura de dados seja homologada, confirme sua aprovação ou ajuste sobre os seguintes pontos:

#### Decisão Pendente 1: Destino Financeiro do Reembolso Avulso no Cartão de Crédito
- **Contexto:** Keniel pagou uma compra de R$ 300 no cartão de crédito pessoal e incluiu Mariana no rateio avulso (R$ 100). Mariana transfere R$ 100 via PIX para Keniel.
- **Pergunta:** Como esse dinheiro deve ser contabilizado no financeiro pessoal de Keniel?
  - **Opção A [Recomendada]:** O PIX entra como saldo disponível na conta corrente de Keniel, categorizado como *"Reembolso Recebido (Mariana)"*, sem alterar a fatura do cartão. Quando a fatura do cartão fechar em R$ 300, Keniel utiliza os R$ 100 que recebeu na conta para pagar a fatura.
  - **Opção B:** O sistema deduz automaticamente R$ 100 da fatura aberta do cartão de crédito de Keniel como se fosse um estorno da operadora.

#### Decisão Pendente 2: Transição de Estoque de Espaço Dissolvido
- **Contexto:** Um Espaço Compartilhado com módulo de listas ativas e estoque cadastrado (ex: 50 itens de despensa) é encerrado/excluído pelos membros.
- **Pergunta:** O que deve acontecer com o catálogo de itens e quantidades?
  - **Opção A [Recomendada]:** As listas e itens são arquivados juntamente com o Espaço, mantendo o histórico de compras intacto para auditoria, mas sem poluir a lista pessoal do criador.
  - **Opção B:** O sistema oferece a opção de exportar/migrar os itens da lista para a Lista Individual de Compras do proprietário (`ownerId`).

#### Decisão Pendente 3: Flexibilidade de Transferências / Adiantamentos
- **Contexto:** Transferências entre dois participantes para custódia de valores (como no Cenário 18).
- **Pergunta:**
  - **Opção A [Recomendada]:** Permitir que um participante envie uma transferência com saldo livre para o outro a qualquer momento (sem exigir despesa atrelada), ficando sob custódia para abater despesas futuras ou ser devolvido.
  - **Opção B:** Exigir que toda transferência esteja obrigatoriamente vinculada a uma despesa compartilhada já cadastrada.

---

# Conclusão

Esta proposta de arquitetura de dados resolve definitivamente as causas-raiz de todas as fragilidades apontadas na auditoria técnica cruzada:
- Elimina a sobrecarga e o acoplamento da coleção `transactions`;
- Garante independência real ao financeiro individual;
- Constrói o fluxo bidirecional em duas vias para rateios avulsos e transferências sob custódia;
- Integra o checkout das listas com as despesas certas (pessoais ou coletivas) e atualiza estoques sem criar órfãos;
- Protege dados bancários em coleções privadas no nível de banco de dados.

O documento normativo completo está preservado no artefato **`arquitetura_de_dados_definitiva.md`**.

Reiterando: **nenhum arquivo de código foi implementado ou alterado.** Aguardo suas respostas sobre as 3 decisões pendentes para que possamos, sob sua autorização expressa, validar a arquitetura final.
