# Especificação da Arquitetura de Dados Definitiva (Versão 2 Corrigida)
## Sistema Financeiro Individual, Espaços Compartilhados, Rateios Avulsos, Transferências e Listas de Aquisição

**Documento Oficial de Engenharia de Dados e Governança de Software**  
**Status:** Revisão 2.0 Submetida para Aprovação do Usuário  
**Autorização de Implementação:** NÃO AUTORIZADA (Documento Estritamente Normativo e Conceitual)  
**Data:** 09 de Novembro de 2026  
**Auditoria de Código-Fonte:** `src/types/finance.ts`, `src/types/acquisitions.ts`, `src/utils/financeEngine.ts`, `src/utils/stateMachine.ts`, `src/App.tsx`.

---

# SEÇÃO 1: Diagnóstico da Arquitetura Atual

A auditoria no código-fonte confirmou a existência de limitações e acoplamentos estruturais que motivam a nova arquitetura:

1. **Sobrecarga da Entidade `Transaction` (`src/types/finance.ts:68-102`):**
   - O documento em `/transactions` acumula simultaneamente despesas individuais, receitas, despesas coletivas, liquidações sintéticas (`Reembolso Livro-Razão:`) e rateios avulsos. A única distinção é a presença ou ausência da string `spaceId` e condicionais textuais.
2. **Fragilidade de Consultas e Vínculo por E-mail (`src/App.tsx:605-608`):**
   - A query `where('participantEmails', 'array-contains', email)` indexa lançamentos por e-mail em vez de UIDs estáveis do Firebase Auth. Se o e-mail mudar, o vínculo é quebrado.
3. **Falha Crítica na Quitação de Cartão de Crédito (`src/App.tsx:825-865`):**
   - A função `handlePayInvoice(card, invoiceMonth, _sourceCheckingId)` recebe a conta corrente pagadora no argumento `_sourceCheckingId`, mas a variável é prefixada com underscore e **totalmente ignorada**. As compras são marcadas como `paid` sem debitar o saldo de nenhuma conta bancária.
4. **Inexistência de Entidade de Transferência e Custódia:**
   - `SettlementTransfer` (`src/types/finance.ts:119`) é apenas uma interface em memória para o cálculo do resumo mensal. Não há suporte a adiantamentos, custódia ou devoluções parciais.
5. **Desconexão Bidirecional entre Listas e Finanças (`src/App.tsx:2584-2596`):**
   - Ao comprar um item no carrinho, o sistema abre o modal de despesa, mas executa `setPresetSpaceId(undefined)` e não grava o `itemId` na transação nem o `transactionId` no item, impossibilitando conciliação ou reversão automática.

---

# SEÇÃO 2: Princípios e Decisões de Negócio Respeitados

Esta especificação incorpora formalmente as decisões aprovadas pelo usuário:

1. **Eliminação Total de Fundo de Reserva ou Caixa Coletivo:**
   - Não existem as entidades `SharedResourcePool`, `ResourceMovement` ou fontes como `free_shared_pool` e `pool_conversion`.
   - O envio de dinheiro para outra pessoa é modelado estritamente como **Transferência sob Custódia** entre pessoas físicas (`senderUid` $\rightarrow$ `custodianUid`), com controle de saldo disponível, utilização e devolução.
2. **Validação Atribuída ao Responsável pela Despesa ou Pendência:**
   - A pessoa que arcou financeiramente com a despesa (ou a quem o valor é devido) é a autoridade legítima para confirmar o recebimento do reembolso ou a baixa da pendência.
   - O validador **pode ser o criador, executor ou financiador** da despesa. A aprovação não é autoaprovação arbitrária: é o credor atestando que recebeu o que lhe era devido.
   - A validação preserva histórico e não dispara débitos bancários automáticos sem confirmação.
3. **Reembolsos Avulsos em Duas Vias com Entrada Real:**
   - A declaração de pagamento pelo devedor não debita seu banco nem credita o do credor imediatamente.
   - O credor confirma o recebimento e escolhe a conta ou carteira de destino.
   - O valor entra como **Reembolso Vinculado** na conta do credor, sem alterar a fatura do cartão nem inflar a receita comum.
4. **Propriedade Formal dos Itens Adquiridos em Listas:**
   - Cada item registra sua modalidade de propriedade: Individual, Compartilhada entre Participantes ou Patrimônio Comum do Espaço.
   - Os percentuais de copropriedade são calculados automaticamente a partir dos valores efetivamente desembolsados por cada participante.
   - No encerramento do espaço, os bens são destinados conforme a propriedade registrada.
5. **Base Greenfield (Banco Limpo):**
   - A arquitetura é projetada diretamente para a nova estrutura, sem necessidade de compatibilidade ou migração do modelo legado.

---

# SEÇÃO 3: Modelo Completo de Entidades e Campos

Todos os valores monetários são representados em **centavos inteiros** (`number` positivo). Todas as referências a usuários utilizam **estritamente o `uid` do Firebase Auth**.

Para cada campo e entidade, identifica-se:
- `[REGRA JÁ APROVADA]`: Diretriz de negócio validada pelo usuário.
- `[DECISÃO TÉCNICA PROPOSTA]`: Solução de engenharia adotada para atender à regra.

---

### 3.1. Núcleo Individual: Contas e Transações Pessoais

#### `Account` (`accounts/{accountId}`)
*Representa uma conta bancária corrente ou cartão de crédito pessoal.*
- `id`: string (PK)
- `userId`: string (FK `users/{uid}`) `[REGRA JÁ APROVADA]`
- `name`: string (Ex: "Nubank", "Itaú Corrente") `[REGRA JÁ APROVADA]`
- `type`: `'checking' | 'credit'` `[REGRA JÁ APROVADA]`
- `currentBalanceCents`: number (Saldo real em centavos para conta corrente) `[DECISÃO TÉCNICA PROPOSTA]`
- `creditLimitCents`: number (Limite total do cartão de crédito) `[REGRA JÁ APROVADA]`
- `closingDay`: number (1 a 31) `[REGRA JÁ APROVADA]`
- `dueDay`: number (1 a 31) `[REGRA JÁ APROVADA]`
- `color`: string
- `icon`: string
- `isArchived`: boolean `[DECISÃO TÉCNICA PROPOSTA]`
- `createdAt`: string (ISO)

#### `PrivatePaymentMetadata` (`accounts/{accountId}/private_payment_metadata/{paymentId}`)
*Subcoleção isolada fisicamente na conta do titular para garantir privacidade bancária perante outros membros:*
- `paymentId`: string (PK)
- `userId`: string (FK `users/{uid}`) `[REGRA JÁ APROVADA]`
- `accountId`: string (FK `accounts/{accountId}`) `[REGRA JÁ APROVADA]`
- `bankName`: string (Ex: "Banco Itaú S.A.") `[REGRA JÁ APROVADA]`
- `accountType`: `'checking' | 'credit'` `[REGRA JÁ APROVADA]`
- `realBankDebitTimestamp`: string (ISO) `[DECISÃO TÉCNICA PROPOSTA]`
- `receiptStorageUrl`?: string (Recibo confidencial) `[REGRA JÁ APROVADA]`

#### `PersonalTransaction` (`users/{userId}/personal_transactions/{txId}`)
*Despesas e receitas exclusivamente individuais do usuário (sem vínculo coletivo):*
- `id`: string (PK)
- `userId`: string (FK `users/{uid}`) `[REGRA JÁ APROVADA]`
- `description`: string `[REGRA JÁ APROVADA]`
- `amountCents`: number `[REGRA JÁ APROVADA]`
- `type`: `'income' | 'expense'` `[REGRA JÁ APROVADA]`
- `status`: `'pending' | 'paid' | 'overdue'` `[REGRA JÁ APROVADA]`
- `categoryId`: string (FK `categories/{categoryId}`) `[REGRA JÁ APROVADA]`
- `categoryName`: string
- `accountId`: string (FK `accounts/{accountId}`) `[REGRA JÁ APROVADA]`
- `competenceDate`: string (YYYY-MM-DD) `[REGRA JÁ APROVADA]`
- `dueDate`: string (YYYY-MM-DD) `[REGRA JÁ APROVADA]`
- `paymentDate`?: string (YYYY-MM-DD) `[REGRA JÁ APROVADA]`
- `invoiceMonth`: string (YYYY-MM) `[REGRA JÁ APROVADA]`
- `originType`: `'manual' | 'shopping_list' | 'internal_transfer' | 'adhoc_reimbursement'` `[DECISÃO TÉCNICA PROPOSTA]`
- `originRefId`?: string (ID da lista, transferência ou rateio de origem) `[DECISÃO TÉCNICA PROPOSTA]`
- `clientTransactionUuid`: string (Idempotência) `[DECISÃO TÉCNICA PROPOSTA]`
- `createdAt`: string (ISO)

#### `InternalAccountTransfer` (`users/{userId}/internal_transfers/{transferId}`)
*Transferências entre contas bancárias do mesmo titular (ex: Itaú $\rightarrow$ Nubank):*
- `id`: string (PK)
- `userId`: string (FK `users/{uid}`) `[REGRA JÁ APROVADA]`
- `sourceAccountId`: string (FK `accounts/{accountId}`) `[REGRA JÁ APROVADA]`
- `destinationAccountId`: string (FK `accounts/{accountId}`) `[REGRA JÁ APROVADA]`
- `amountCents`: number `[REGRA JÁ APROVADA]`
- `transferDate`: string (YYYY-MM-DD) `[REGRA JÁ APROVADA]`
- `description`: string
- `clientTransactionUuid`: string `[DECISÃO TÉCNICA PROPOSTA]`
- `createdAt`: string (ISO)

---

### 3.2. Cartões de Crédito e Faturas

#### `CreditCardInvoice` (`accounts/{accountId}/invoices/{invoiceMonth}`)
*Representação formal da fatura de cartão de crédito para a competência YYYY-MM:*
- `id`: string (PK: `invoiceMonth`, ex: "2026-11")
- `accountId`: string (FK `accounts/{accountId}`) `[REGRA JÁ APROVADA]`
- `userId`: string (FK `users/{uid}`) `[REGRA JÁ APROVADA]`
- `invoiceMonth`: string (YYYY-MM) `[REGRA JÁ APROVADA]`
- `closingDate`: string (YYYY-MM-DD) `[REGRA JÁ APROVADA]`
- `dueDate`: string (YYYY-MM-DD) `[REGRA JÁ APROVADA]`
- `totalPurchasesAmountCents`: number (Soma das compras da competência) `[DECISÃO TÉCNICA PROPOSTA]`
- `carriedOverBalanceCents`: number (Saldo rolado da fatura anterior) `[REGRA JÁ APROVADA]`
- `interestAndFeesCents`: number (Encargos, multas e juros de atraso) `[REGRA JÁ APROVADA]`
- `totalDueAmountCents`: number (`totalPurchases + carriedOver + interestAndFees`) `[DECISÃO TÉCNICA PROPOSTA]`
- `totalPaidAmountCents`: number (Soma de pagamentos parciais reconhecidos) `[REGRA JÁ APROVADA]`
- `remainingBalanceCents`: number (`totalDueAmountCents - totalPaidAmountCents`) `[REGRA JÁ APROVADA]`
- `invoiceStatus`: `'open' | 'closed' | 'partially_paid' | 'paid' | 'overdue'` `[REGRA JÁ APROVADA]`
- `updatedAt`: string (ISO)

#### `InvoicePayment` (`accounts/{accountId}/invoices/{invoiceMonth}/payments/{paymentId}`)
*Registro individual de amortização da fatura (permite múltiplos pagamentos parciais de contas diferentes):*
- `id`: string (PK)
- `invoiceMonth`: string (FK)
- `accountId`: string (Cartão pago)
- `sourceCheckingAccountId`: string (Conta corrente pagadora que sofre débito real) `[REGRA JÁ APROVADA]`
- `amountPaidCents`: number `[REGRA JÁ APROVADA]`
- `paymentDate`: string (YYYY-MM-DD) `[REGRA JÁ APROVADA]`
- `clientTransactionUuid`: string `[DECISÃO TÉCNICA PROPOSTA]`
- `createdAt`: string (ISO)

#### `InvoiceCarryOver` (`accounts/{accountId}/invoices/{invoiceMonth}/carry_overs/{carryId}`)
*Transporte de saldo de fatura não quitada para a competência seguinte (crédito rotativo):*
- `id`: string (PK)
- `sourceInvoiceMonth`: string (Mês de origem vencido) `[REGRA JÁ APROVADA]`
- `targetInvoiceMonth`: string (Próximo mês receptor) `[REGRA JÁ APROVADA]`
- `unpaidPrincipalCents`: number (Saldo principal transportado) `[REGRA JÁ APROVADA]`
- `interestRateMonthly`: number (Taxa de juro contratada) `[REGRA JÁ APROVADA]`
- `appliedInterestCents`: number (Juros calculados) `[REGRA JÁ APROVADA]`
- `status`: `'active' | 'settled'` `[DECISÃO TÉCNICA PROPOSTA]`
- `createdAt`: string (ISO)

---

### 3.3. Núcleo de Espaços Compartilhados e Governança

#### `Space` (`spaces/{spaceId}`)
*Entidade central de governança do grupo coletivo:*
- `id`: string (PK)
- `ownerId`: string (FK `users/{uid}`) `[REGRA JÁ APROVADA]`
- `name`: string `[REGRA JÁ APROVADA]`
- `description`: string
- `icon`: string
- `color`: string
- `spaceStatus`: `'active' | 'archived' | 'pending_deletion' | 'deleted'` `[REGRA JÁ APROVADA]`
- `memberUids`: string[] (Array indexado para regras de segurança e ACL) `[REGRA JÁ APROVADA]`
- `enabledModules`: Array<`'finance' | 'acquisitions'`> `[REGRA JÁ APROVADA]`
- `monthlyBudgetCents`?: number
- `createdAt`: string (ISO)

#### `SpaceMember` (`spaces/{spaceId}/members/{memberUid}`)
*Participação e papel de cada participante no espaço (estados desacoplados do espaço):*
- `id`: string (PK: `memberUid`)
- `spaceId`: string (FK `spaces/{spaceId}`)
- `uid`: string (FK `users/{uid}`) `[REGRA JÁ APROVADA]`
- `name`: string
- `email`: string
- `role`: `'owner' | 'admin' | 'member'` `[REGRA JÁ APROVADA]`
- `participationStatus`: `'invited' | 'active' | 'voluntary_exit' | 'removed_by_admin' | 'declined'` `[REGRA JÁ APROVADA]`
- `statusReason`?: string (Motivo da recusa ou saída) `[DECISÃO TÉCNICA PROPOSTA]`
- `invitedAt`: string (ISO)
- `respondedAt`?: string (ISO)

#### `SharedExpense` (`spaces/{spaceId}/shared_expenses/{expenseId}`)
*Despesa coletiva com separação formal de papéis:*
- `id`: string (PK)
- `spaceId`: string (FK `spaces/{spaceId}`) `[REGRA JÁ APROVADA]`
- `title`: string `[REGRA JÁ APROVADA]`
- `description`?: string
- `totalOriginalAmountCents`: number (Valor original da obrigação) `[REGRA JÁ APROVADA]`
- `competenceMonth`: string (YYYY-MM) `[REGRA JÁ APROVADA]`
- `competenceDate`: string (YYYY-MM-DD) `[REGRA JÁ APROVADA]`
- `dueDate`?: string (YYYY-MM-DD)
- `categoryId`: string
- `categoryName`: string
- **Papéis Desacoplados:**
  - `createdByUid`: string (Autor do cadastro) `[REGRA JÁ APROVADA]`
  - `responsibleUid`: string (Responsável financeiro da despesa / Credor das cotas) `[REGRA JÁ APROVADA]`
- **Máquinas de Estado:**
  - `validationStatus`: `'pending_validation' | 'approved' | 'rejected' | 'cancelled'` `[REGRA JÁ APROVADA]`
  - `commitmentStatus`: `'active' | 'closed' | 'cancelled_pre_payment' | 'loss_unrecoverable'` `[REGRA JÁ APROVADA]`
  - `paymentExecutionStatus`: `'unpaid' | 'partially_paid' | 'fully_paid'` `[REGRA JÁ APROVADA]`
- `validatedByUid`?: string (Responsável que validou) `[REGRA JÁ APROVADA]`
- `validatedAt`?: string
- `rejectionReason`?: string
- `totalPaidToSupplierCents`: number (Valor reconhecido perante o fornecedor) `[DECISÃO TÉCNICA PROPOSTA]`
- `supplierUnpaidBalanceCents`: number (`totalOriginal - totalPaidToSupplier`) `[DECISÃO TÉCNICA PROPOSTA]`
- `originType`: `'manual' | 'shopping_list' | 'installment'` `[REGRA JÁ APROVADA]`
- `originRefId`?: string (FK `items/{itemId}`)
- `clientTransactionUuid`: string
- `createdAt`: string (ISO)

#### `ExpenseLiability` (`spaces/{spaceId}/shared_expenses/{expenseId}/liabilities/{memberUid}`)
*Cota de responsabilidade de cada participante no rateio:*
- `id`: string (PK: `memberUid`)
- `expenseId`: string (FK)
- `spaceId`: string (FK)
- `memberUid`: string (FK `users/{uid}`) `[REGRA JÁ APROVADA]`
- `memberName`: string
- `assignedShareAmountCents`: number (Cota bruta atribuída) `[REGRA JÁ APROVADA]`
- `adjustedShareAmountCents`: number (Cota líquida após devoluções/perdas do fornecedor) `[REGRA JÁ APROVADA]`
- `splitMethod`: `'equal' | 'percentage' | 'custom_value'` `[REGRA JÁ APROVADA]`
- `splitRatio`?: number
- `roundingRemainderRank`?: number (Critério Hamilton/Hare) `[REGRA JÁ APROVADA]`

#### `ExpensePayment` (`spaces/{spaceId}/shared_expenses/{expenseId}/payments/{paymentId}`)
*Desembolso financeiro com segregação de executor e financiador:*
- `id`: string (PK)
- `expenseId`: string (FK)
- `spaceId`: string (FK)
- `amountCents`: number `[REGRA JÁ APROVADA]`
- `paymentDate`: string (YYYY-MM-DD) `[REGRA JÁ APROVADA]`
- `executedByUid`: string (Quem entregou o dinheiro ao fornecedor) `[REGRA JÁ APROVADA]`
- `executedByName`: string
- `economicFunderUid`: string (Quem forneceu o recurso original) `[REGRA JÁ APROVADA]`
- `economicFunderName`: string
- `fundingSource`: `'personal_checking' | 'credit_card' | 'custody_transfer'` `[REGRA JÁ APROVADA]`
- `custodyTransferId`?: string (FK `transfers/{transferId}`, se custódia) `[REGRA JÁ APROVADA]`
- `publicPayerLabel`: string (Ex: "Recurso próprio de Keniel") `[REGRA JÁ APROVADA]`
- `validationStatus`: `'pending_validation' | 'approved' | 'rejected'` `[REGRA JÁ APROVADA]`
- `validatedByUid`?: string (O `responsibleUid` da despesa valida o pagamento) `[REGRA JÁ APROVADA]`
- `rejectionReason`?: string
- `clientTransactionUuid`: string
- `createdAt`: string (ISO)

#### `BilateralDebtLedger` (`spaces/{spaceId}/shared_expenses/{expenseId}/bilateral_debts/{debtId}`)
*Projeção determinística de créditos bilaterais constituídos:*
- `id`: string (PK: `debtorUid_creditorUid`)
- `expenseId`: string (FK)
- `spaceId`: string (FK)
- `competenceMonth`: string (YYYY-MM)
- `debtorUid`: string (Participante financiado) `[REGRA JÁ APROVADA]`
- `debtorName`: string
- `creditorUid`: string (Participante que financiou além de sua cota) `[REGRA JÁ APROVADA]`
- `creditorName`: string
- `originalFinancedAmountCents`: number `[REGRA JÁ APROVADA]`
- `liquidatedCents`: number (Amortizado via liquidação) `[REGRA JÁ APROVADA]`
- `currentRemainingDebtCents`: number (`originalFinanced - liquidated`) `[REGRA JÁ APROVADA]`
- `status`: `'open' | 'partially_settled' | 'fully_settled'` `[REGRA JÁ APROVADA]`

#### `SettlementRecord` (`spaces/{spaceId}/settlements/{settlementId}`)
*Acerto formal de contas entre devedor e credor:*
- `id`: string (PK)
- `spaceId`: string (FK)
- `debtorUid`: string (Quem paga a dívida) `[REGRA JÁ APROVADA]`
- `creditorUid`: string (Quem recebe o dinheiro) `[REGRA JÁ APROVADA]`
- `amountSettledCents`: number `[REGRA JÁ APROVADA]`
- `settlementDate`: string (YYYY-MM-DD) `[REGRA JÁ APROVADA]`
- `paymentDeclarationProofUrl`?: string
- `status`: `'pending_confirmation' | 'confirmed' | 'rejected' | 'reverted'` `[REGRA JÁ APROVADA]`
- `confirmedAt`?: string
- `confirmedByUid`?: string (O `creditorUid` confirma o recebimento) `[REGRA JÁ APROVADA]`
- `clientTransactionUuid`: string
- `createdAt`: string (ISO)

#### `SettlementAllocation` (`spaces/{spaceId}/settlements/{settlementId}/allocations/{allocationId}`)
*Amortização FIFO atrelada a cada dívida bilateral específica:*
- `id`: string (PK)
- `settlementId`: string (FK)
- `bilateralDebtId`: string (FK `BilateralDebtLedger/{debtId}`) `[REGRA JÁ APROVADA]`
- `expenseId`: string (FK `SharedExpense/{expenseId}`) `[REGRA JÁ APROVADA]`
- `competenceMonth`: string (YYYY-MM) `[REGRA JÁ APROVADA]`
- `amountAllocatedCents`: number `[REGRA JÁ APROVADA]`

#### `SettlementReversionEvent` (`spaces/{spaceId}/settlements/{settlementId}/reversions/{reversionId}`)
*Trilha imutável em caso de estorno de liquidação:*
- `id`: string (PK)
- `settlementId`: string (FK)
- `requestedByUid`: string `[REGRA JÁ APROVADA]`
- `confirmedByUid`: string `[REGRA JÁ APROVADA]`
- `revertReason`: string `[REGRA JÁ APROVADA]`
- `revertedAt`: string (ISO) `[DECISÃO TÉCNICA PROPOSTA]`

#### `SupplierRefundEvent` (`spaces/{spaceId}/shared_expenses/{expenseId}/refunds/{refundId}`)
*Eventos de cancelamento ou devolução pelo fornecedor comercial:*
- `id`: string (PK)
- `expenseId`: string (FK)
- `refundType`: `'full_refund' | 'partial_refund' | 'unrecoverable_loss'` `[REGRA JÁ APROVADA]`
- `amountRefundedCents`: number (Valor devolvido pelo fornecedor) `[REGRA JÁ APROVADA]`
- `lossAmountCents`: number (Prejuízo retido pelo fornecedor) `[REGRA JÁ APROVADA]`
- `recipientUid`: string (Participante que recebeu a devolução bancária) `[REGRA JÁ APROVADA]`
- `destinationAccountId`?: string (Conta onde caiu a devolução) `[REGRA JÁ APROVADA]`
- `date`: string (YYYY-MM-DD)
- `justification`: string `[REGRA JÁ APROVADA]`
- `createdAt`: string (ISO)

---

### 3.4. Núcleo de Rateios Avulsos (Despesas Fora de Espaço)

#### `AdhocSplitExpense` (`adhoc_expenses/{expenseId}`)
*Despesa individual com divisão externa:*
- `id`: string (PK)
- `ownerUid`: string (Autor da compra original) `[REGRA JÁ APROVADA]`
- `ownerName`: string
- `title`: string `[REGRA JÁ APROVADA]`
- `description`?: string
- `totalAmountCents`: number `[REGRA JÁ APROVADA]`
- `ownerShareAmountCents`: number (Cota que cabe ao autor) `[REGRA JÁ APROVADA]`
- `totalToReimburseCents`: number (`totalAmountCents - ownerShareAmountCents`) `[REGRA JÁ APROVADA]`
- `totalReimbursedCents`: number (Soma de reembolsos confirmados) `[REGRA JÁ APROVADA]`
- `fundingSource`: `'personal_checking' | 'credit_card'` `[REGRA JÁ APROVADA]`
- `sourceAccountId`: string (FK `accounts/{accountId}`) `[REGRA JÁ APROVADA]`
- `date`: string (YYYY-MM-DD)
- `status`: `'active' | 'fully_reimbursed' | 'cancelled'` `[REGRA JÁ APROVADA]`
- `participantUids`: string[] (Array com UIDs de convidados) `[REGRA JÁ APROVADA]`
- `createdAt`: string (ISO)

#### `AdhocSplitObligation` (`users/{guestUid}/adhoc_obligations/{obligationId}`)
*Conta a pagar registrada no banco do convidado:*
- `id`: string (PK)
- `adhocExpenseId`: string (FK `adhoc_expenses/{expenseId}`) `[REGRA JÁ APROVADA]`
- `guestUid`: string (FK `users/{guestUid}`) `[REGRA JÁ APROVADA]`
- `creditorUid`: string (FK `users/{ownerUid}`) `[REGRA JÁ APROVADA]`
- `creditorName`: string
- `assignedAmountCents`: number (Cota original devida) `[REGRA JÁ APROVADA]`
- `paidAmountCents`: number (Total de pagamentos informados e confirmados) `[REGRA JÁ APROVADA]`
- `remainingBalanceCents`: number (`assignedAmountCents - paidAmountCents`) `[REGRA JÁ APROVADA]`
- `obligationStatus`: `'pending_invite' | 'accepted' | 'rejected' | 'payment_informed' | 'confirmed_cleared'` `[REGRA JÁ APROVADA]`
- `guestRejectionReason`?: string
- `paymentDeclarationDate`?: string
- `paymentProofUrl`?: string
- `updatedAt`: string (ISO)

#### `AdhocReimbursement` (`adhoc_expenses/{expenseId}/reimbursements/{reimbursementId}`)
*Entrada financeira real de reembolso:*
- `id`: string (PK)
- `adhocExpenseId`: string (FK)
- `obligationId`: string (FK `AdhocSplitObligation`) `[REGRA JÁ APROVADA]`
- `debtorUid`: string (Convidado pagador) `[REGRA JÁ APROVADA]`
- `creditorUid`: string (Credor recebedor) `[REGRA JÁ APROVADA]`
- `amountCents`: number `[REGRA JÁ APROVADA]`
- `paymentDate`: string (YYYY-MM-DD)
- `status`: `'pending_confirmation' | 'confirmed' | 'rejected'` `[REGRA JÁ APROVADA]`
- `destinationAccountId`?: string (Conta bancária escolhida pelo credor no ato da confirmação) `[REGRA JÁ APROVADA]`
- `confirmedAt`?: string
- `rejectionReason`?: string
- `clientTransactionUuid`: string `[DECISÃO TÉCNICA PROPOSTA]`
- `createdAt`: string (ISO)

---

### 3.5. Núcleo de Transferências e Adiantamentos (Custódia de Valores)

#### `CustodyTransfer` (`transfers/{transferId}`)
*Contrato de custódia entre remetente e custodiante:*
- `id`: string (PK)
- `spaceId`?: string (Opcional: preenchido se adiantamento de espaço) `[REGRA JÁ APROVADA]`
- `senderUid`: string (Quem enviou o dinheiro) `[REGRA JÁ APROVADA]`
- `senderName`: string
- `custodianUid`: string (Quem recebeu e custódia o valor) `[REGRA JÁ APROVADA]`
- `custodianName`: string
- `initialAmountCents`: number [centavos] `[REGRA JÁ APROVADA]`
- `usedAmountCents`: number (Consumido em despesas) `[REGRA JÁ APROVADA]`
- `returnedAmountCents`: number (Devolvido ao remetente) `[REGRA JÁ APROVADA]`
- `availableBalanceCents`: number (`initial - used - returned`) `[REGRA JÁ APROVADA]`
- `targetExpenseId`?: string (Despesa específica carimbada, se houver) `[REGRA JÁ APROVADA]`
- `custodyStatus`: `'pending_receipt' | 'custody_active' | 'exhausted' | 'fully_returned'` `[REGRA JÁ APROVADA]`
- `createdAt`: string (ISO)

#### `CustodyTransferEvent` (`transfers/{transferId}/events/{eventId}`)
*Trilha imutável de movimentações da custódia:*
- `id`: string (PK)
- `transferId`: string (FK)
- `eventType`: `'transfer_sent' | 'receipt_confirmed' | 'expense_consumed' | 'partial_return_sent' | 'partial_return_confirmed'` `[REGRA JÁ APROVADA]`
- `amountCents`: number `[REGRA JÁ APROVADA]`
- `targetExpenseId`?: string
- `performedByUid`: string `[REGRA JÁ APROVADA]`
- `justification`?: string
- `clientTransactionUuid`: string
- `timestamp`: string (ISO)

---

### 3.6. Núcleo de Listas de Aquisição e Propriedade de Bens

#### `AcquisitionList` (`acquisition_lists/{listId}`)
*Lista de compras associada a um Usuário ou a um Espaço:*
- `id`: string (PK)
- `scopeType`: `'individual' | 'shared'` `[REGRA JÁ APROVADA]`
- `ownerUid`: string (Preenchido se `individual`, FK `users/{uid}`) `[REGRA JÁ APROVADA]`
- `spaceId`?: string (Preenchido se `shared`, FK `spaces/{spaceId}`) `[REGRA JÁ APROVADA]`
- `name`: string `[REGRA JÁ APROVADA]`
- `description`: string
- `type`: `'recorrente' | 'objetivo' | 'desejo'` `[REGRA JÁ APROVADA]`
- `memberUids`: string[] (Array para ACL e permissões) `[REGRA JÁ APROVADA]`
- `createdByUid`: string (Autor da lista) `[REGRA JÁ APROVADA]`
- `createdAt`: string (ISO)

#### `AcquisitionItem` (`acquisition_lists/{listId}/items/{itemId}`)
*Item da lista com rastreamento completo de propriedade e financeiro:*
- `id`: string (PK)
- `listId`: string (FK `acquisition_lists/{listId}`)
- `scopeType`: `'individual' | 'shared'` `[REGRA JÁ APROVADA]`
- `ownerUid`: string (Se individual)
- `spaceId`?: string (Se compartilhada)
- `name`: string `[REGRA JÁ APROVADA]`
- `groupId`: string (FK `taxonomy/{groupId}`) `[REGRA JÁ APROVADA]`
- `categoryId`: string (FK `taxonomy/{groupId}/categories/{categoryId}`) `[REGRA JÁ APROVADA]`
- `listType`: `'recorrente' | 'objetivo' | 'desejo'` `[REGRA JÁ APROVADA]`
- `stage`: string (Estágio Kanban da máquina de estados) `[REGRA JÁ APROVADA]`
- `createdByUid`: string (Autor do item) `[REGRA JÁ APROVADA]`
- `notes`?: string
- **Campos Recorrente:** `currentStock`, `minStock`, `unit` (`un`, `kg`, `L`, `pct`, `cx`), `cartDraft` `[REGRA JÁ APROVADA]`
- **Campos Objetivo:** `targetAmountCents`, `savedAmountCents`, `finalPaidAmountCents`, `quotes[]`, `deposits[]` `[REGRA JÁ APROVADA]`
- **Campos Desejo:** `estimatedPriceCents`, `priority` (`Baixa | Média | Alta`), `inspirationUrl`, `prosAndCons` `[REGRA JÁ APROVADA]`
- **Modelo Explícito de Propriedade do Bem:**
  - `ownershipType`: `'individual' | 'shared_participants' | 'space_asset'` `[REGRA JÁ APROVADA]`
  - `owners`: Array<{
      `uid`: string;
      `name`: string;
      `disbursedAmountCents`: number;
      `ownershipPercentage`: number;
    }> `[REGRA JÁ APROVADA]`
  - `buyerUid`?: string (Quem realizou a compra física) `[REGRA JÁ APROVADA]`
  - `funderUid`?: string (Quem financiou economicamente a compra) `[REGRA JÁ APROVADA]`
  - `linkedExpenseId`?: string (FK da despesa gerada) `[REGRA JÁ APROVADA]`
  - `linkedExpenseType`?: `'personal' | 'shared'` `[REGRA JÁ APROVADA]`
- `updatedAt`: string (ISO)

#### `ProductPurchase` (`acquisition_lists/{listId}/items/{itemId}/products/{productId}`)
*Histórico de compras do item:*
- `id`: string (PK)
- `itemId`: string (FK)
- `buyerUid`: string (Quem comprou) `[REGRA JÁ APROVADA]`
- `brand`: string
- `unitPriceCents`: number
- `quantity`: number
- `totalPriceCents`: number (`unitPrice * quantity`)
- `storeName`: string
- `purchaseDate`: string (ISO)
- `receiptUrl`?: string

---

# SEÇÃO 4: Relacionamentos e Cardinalidades

```
┌─────────────────────────────────┐
│              User               │
│      (uid, email, name)         │
└────────────────┬────────────────┘
                 │
                 ├── 1:N ──> Account ── 1:1 ──> PrivatePaymentMetadata
                 │                 │
                 │                 └── 1:N ──> CreditCardInvoice ── 1:N ──> InvoicePayment
                 │                                        │
                 │                                        └── 1:N ──> InvoiceCarryOver
                 │
                 ├── 1:N ──> PersonalTransaction (Finanças Pessoais Isoladas)
                 │
                 ├── 1:N ──> InternalAccountTransfer (Transferências entre Contas Próprias)
                 │
                 ├── 1:N ──> AdhocSplitObligation (Contas a Pagar do Convidado em Rateios Avulsos)
                 │
                 ├── 1:N ──> AdhocSplitExpense (Rateios Avulsos Criados pelo Autor)
                 │                 │
                 │                 └── 1:N ──> AdhocReimbursement (Baixa e Crédito Vinculado)
                 │
                 ├── 1:N ──> CustodyTransfer (Adiantamentos: Remetente ou Custodiante)
                 │                 │
                 │                 └── 1:N ──> CustodyTransferEvent (Histórico Imutável)
                 │
                 ├── 1:N ──> AcquisitionList [scopeType: 'individual']
                 │                 │
                 │                 └── 1:N ──> AcquisitionItem
                 │
                 └── N:M ──> Space (Espaços Compartilhados)
                               │
                               ├── 1:N ──> SpaceMember (Estados independentes de participação)
                               │
                               ├── 1:N ──> AcquisitionList [scopeType: 'shared']
                               │                 │
                               │                 └── 1:N ──> AcquisitionItem (com copropriedade)
                               │
                               └── 1:N ──> SharedExpense (Despesas Coletivas)
                                                 │
                                                 ├── 1:N ──> ExpenseLiability (Cotas brutas)
                                                 │
                                                 ├── 1:N ──> ExpensePayment (Pagamentos reconhecidos)
                                                 │
                                                 ├── 1:N ──> BilateralDebtLedger (Visão determinística)
                                                 │                 │
                                                 │                 └── 1:N ──< SettlementAllocation
                                                 │                                      │
                                                 ├── 1:N ──> SettlementRecord ──────────┘
                                                 │                 │
                                                 │                 └── 1:N ──> SettlementReversionEvent
                                                 │
                                                 └── 1:N ──> SupplierRefundEvent (Estorno do fornecedor)
```

---

# SEÇÃO 5: Fluxos Financeiros Detalhados

### 5.1. Fluxo de Rateio Avulso em Duas Vias (Keniel R$ 300 / Mariana R$ 100)
1. **Registro:** Keniel cadastra a despesa de R$ 300 no financeiro pessoal e adiciona Mariana para reembolsar R$ 100.
   - Cria `AdhocSplitExpense` (total R$ 300, cota Keniel R$ 200, a reembolsar R$ 100).
   - Cria `AdhocSplitObligation` no perfil de Mariana (`/users/mariana/adhoc_obligations/ob_123`) com status `pending_invite`.
2. **Aceite:** Mariana acessa a tela de Notificações/Inbox e aceita o rateio.
   - Status passa para `accepted`. O valor de R$ 100 entra oficialmente no passivo individual de Mariana.
3. **Declaração de Pagamento:** Mariana faz o PIX de R$ 100 para Keniel e clica em "Informar Pagamento".
   - Status da obrigação passa para `payment_informed`.
   - **Garantia Contábil:** A conta bancária de Mariana **não é debitada automaticamente pelo sistema** e a de Keniel **não é creditada ainda**. Cria-se `AdhocReimbursement` com status `pending_confirmation`.
4. **Confirmação e Entrada Real:** Keniel confere seu extrato bancário, escolhe a conta de destino (ex: "Nubank") e clica em "Confirmar Recebimento".
   - Executa `runTransaction`:
     a) `AdhocReimbursement` vai para `confirmed`.
     b) `AdhocSplitObligation` de Mariana é baixada para `confirmed_cleared`.
     c) Registra entrada financeira real de R$ 100 na conta Nubank de Keniel, identificada como **Reembolso Vinculado** à despesa de R$ 300.
     d) **Prevenção de Duplicidade:** O sistema NÃO soma R$ 100 como receita comum de Keniel. O valor abate o custo líquido da despesa original para R$ 200. Se a despesa original foi no cartão de crédito, a fatura não é alterada (fecha nos R$ 300 originais e Keniel utiliza os R$ 100 recebidos no Nubank para pagá-la).

### 5.2. Fluxo de Adiantamento sob Custódia (Mariana envia R$ 500 / Keniel gasta R$ 350 / Devolve R$ 150)
1. **Envio:** Mariana registra a transferência de R$ 500 para Keniel. Cria `CustodyTransfer` (`initialAmountCents: 50000`, `availableBalanceCents: 50000`, status: `pending_receipt`).
2. **Confirmação de Recebimento:** Keniel confirma o recebimento na sua conta bancária. Status passa para `custody_active`. O dinheiro entra na conta bancária de Keniel sob a rubrica contábil de custódia (passivo), sem constituir receita tributável pessoal.
3. **Utilização em Despesa:** Keniel paga uma conta de condomínio de R$ 350 com esse recurso.
   - Cria `ExpensePayment` com `fundingSource: 'custody_transfer'` e `custodyTransferId: trans_123`.
   - Grava `CustodyTransferEvent` (`expense_consumed`, R$ 350).
   - O `availableBalanceCents` cai para R$ 150. A operação não debita a conta pessoal de Keniel.
4. **Devolução do Saldo:** Keniel faz PIX de R$ 150 de volta para Mariana e clica em "Registrar Devolução".
   - Grava `CustodyTransferEvent` (`partial_return_sent`, R$ 150).
   - Mariana confere o extrato e clica em "Confirmar Devolução".
   - Grava `CustodyTransferEvent` (`partial_return_confirmed`, R$ 150).
   - O saldo sob custódia fecha em R$ 0,00 (`exhausted`). As contas bancárias refletem a saída de R$ 150 de Keniel e a entrada de R$ 150 em Mariana com rastreabilidade 100% auditável.

---

# SEÇÃO 6: Fluxos de Listas, Checkout e Propriedade de Bens

### 6.1. Checkout no Carrinho e Registro de Propriedade
Quando uma compra de carrinho é finalizada:
1. **Lista Individual:**
   - O item vai para `conferido`, o estoque `currentStock` é incrementado.
   - Grava `ProductPurchase` no histórico.
   - Cria atomicamente `PersonalTransaction` com `originType: 'shopping_list'` e `originRefId: itemId`.
   - Propriedade registrada como `ownershipType: 'individual'` com 100% pertencente ao titular.
2. **Lista Compartilhada do Espaço:**
   - O modal de checkout solicita:
     - Quem realizou a compra física (`buyerUid`).
     - Quem financiou economicamente (`funderUid` ou participantes rateados).
     - Forma de pagamento e valores desembolsados por cada participante ($D_i$).
   - **Cálculo Automático de Copropriedade:**
     $$\text{ownershipPercentage}_i = \frac{D_i}{\sum D_i} \times 100$$
   - Grava no `AcquisitionItem`:
     - `ownershipType: 'shared_participants'` (ou `'space_asset'`).
     - Array `owners: [{ uid: 'keniel', disbursedAmountCents: 150000, ownershipPercentage: 50 }, { uid: 'mariana', disbursedAmountCents: 150000, ownershipPercentage: 50 }]`.
   - Cria atomicamente `SharedExpense` com `originType: 'shopping_list'` e salva `linkedExpenseId` no item.

### 6.2. Regras de Destinação dos Bens na Dissolução do Espaço
Caso o Espaço Compartilhado seja arquivado ou encerrado, a destinação dos itens segue rigorosamente o registro de propriedade:
1. **Itens com `ownershipType: 'individual'`:** Permanecem com o participante titular registrado, sendo migrados para sua Lista Pessoal.
2. **Itens com `ownershipType: 'shared_participants'`:** A interface de dissolução apresenta a partilha com base nos percentuais registrados:
   - Se um membro ficar com o bem físico, o sistema calcula a indenização devida aos demais participantes proporcionalmente aos seus percentuais de copropriedade.
3. **Itens com `ownershipType: 'space_asset'` (Patrimônio Comum):** Destinação decidida por deliberação unânime dos membros (doação, venda com rateio igualitário do valor arrecadado ou descarte).

---

# SEÇÃO 7: Regras de Segurança e Permissões Firestore

A matriz de regras é baseada na identificação por `request.auth.uid`:

| Coleção / Subcoleção | `allow read` | `allow create` | `allow update` | `allow delete` |
| :--- | :--- | :--- | :--- | :--- |
| `accounts/{accountId}` | Titular (`auth.uid == resource.data.userId`) | Titular | Titular | Bloqueado se houver transações vinculadas |
| `accounts/{accId}/private_payment_metadata/*` | **Exclusivo do Titular** | Titular | Titular | Proibido |
| `users/{uid}/personal_transactions/*` | Exclusivo do Titular | Titular | Titular | Titular |
| `users/{uid}/adhoc_obligations/*` | Convidado titular e Credor | Credor da despesa original | Convidado (para aceitar/informar pagamento) e Credor (para confirmar) | Proibido |
| `adhoc_expenses/{expenseId}` | Autor e Convidados (`auth.uid in resource.data.participantUids`) | Autor (`auth.uid == request.resource.data.ownerUid`) | Autor | Proibido |
| `spaces/{spaceId}` | Membros ativos (`auth.uid in resource.data.memberUids`) | Autenticado (vira owner) | Owner ou Admin | Owner (se despesas quitadas) |
| `spaces/{spaceId}/shared_expenses/*` | Membros do espaço | Membros do espaço | Autor (se pendente/rejeitado) ou Responsável financeiro (`responsibleUid`) | Proibido (soft-delete via status) |
| `transfers/{transferId}` | Remetente e Custodiante | Remetente | Custodiante (para confirmar) ou Remetente (devolução) | Proibido |
| `acquisition_lists/{listId}` | Titular (se individual) ou Membros (se compartilhada) | Usuário (individual) ou Membros (compartilhada) | Titular ou Membros do espaço | Titular ou Owner do espaço |

---

# SEÇÃO 8: Histórico, Auditoria e Reversões (Event-Sourcing Híbrido)

Para assegurar auditabilidade absoluta sem reescrita de dados:
1. **Imutabilidade do Registro de Origem:** `SharedExpense`, `CustodyTransfer` e `AdhocSplitExpense` nunca têm seus valores originais de criação sobrescritos.
2. **Subcoleções de Eventos Auditados:**
   - Devolução de adiantamento grava `CustodyTransferEvent`.
   - Cancelamento ou perda de fornecedor grava `SupplierRefundEvent`.
   - Estorno de liquidação grava `SettlementReversionEvent`.
   - Confirmação de reembolso grava `AdhocReimbursement`.
3. **Reconstrução Histórica:** O estado de qualquer obrigação ou cota em uma data passada $T$ pode ser reconstruído consultando o documento original somado a todos os eventos com `timestamp <= T`.

---

# SEÇÃO 9: Integridade, Atomicidade e Idempotência

### 9.1. Operações que Exigem Transações Atômicas Obrigatórias (`runTransaction`)
As seguintes operações envolvem mutações em múltiplos documentos e **devem ser 100% atômicas**:
1. **Checkout no Carrinho com Criação de Despesa:** Atualização do estoque no item + criação da despesa + inserção no histórico de compras.
2. **Confirmação de Reembolso Avulso:** Baixa da obrigação do devedor + crédito na conta corrente do credor + marcação do reembolso como confirmado.
3. **Liquidação Bilateral:** Criação do registro de liquidação + amortizações FIFO nas dívidas bilaterais + débitos/créditos em contas bancárias.
4. **Utilização de Adiantamento sob Custódia:** Criação do pagamento da despesa + dedução do saldo disponível em `CustodyTransfer` + inserção do evento em `events/`.

### 9.2. Mecanismo de Idempotência Atômica
Toda solicitação do cliente gera um `clientTransactionUuid` (UUID v4) gravado na coleção `/idempotency_keys/{uuid}` dentro do bloco `runTransaction`:
- Se o documento existir e tiver status `completed`, a transação é abortada retornando a resposta original.
- Se houver falha de rede ou clique duplo do usuário, a operação não é reexecutada e não há cobranças duplicadas.

---

# SEÇÃO 10: Riscos Técnicos e Decisões Pendentes

### 10.1. Riscos Técnicos Identificados
1. **Concorrência em Checkouts Simultâneos:**
   - *Risco:* Dois membros tentarem dar baixa no mesmo item do carrinho ao mesmo tempo.
   - *Mitigação:* `runTransaction` lê a versão atual do item. O primeiro checkout avança para `conferido`; o segundo é rejeitado informando que o item já foi adquirido.
2. **Custódia Prolongada sem Utilização:**
   - *Risco:* Um participante reter adiantamentos sem prestar contas.
   - *Mitigação:* Alerta automático na interface destacando: *"Você possui R$ X sob custódia há mais de 30 dias"*.

---

### 10.2. Decisões Pendentes Submetidas para Sua Homologação

Para fechamento final desta especificação, confirme sua decisão sobre os seguintes pontos:

#### Decisão 1: Notificação de Rateio Avulso para Não-Usuários
- **Contexto:** Keniel registra um rateio avulso e informa o e-mail de um amigo que ainda não tem conta no aplicativo.
- **Opções:**
  - **Opção A [Recomendada]:** O sistema gera um link seguro de convite (via e-mail/WhatsApp). Ao se cadastrar, o amigo já encontra a obrigação pendente pronta em seu inbox.
  - **Opção B:** Permitir rateios avulsos apenas entre usuários já previamente cadastrados no sistema.

#### Decisão 2: Destino de Itens de Consumo Imediato na Dissolução do Espaço
- **Contexto:** Na dissolução de um espaço compartilhado, há itens duráveis (geladeira) e itens perecíveis (detergente, arroz aberto).
- **Opções:**
  - **Opção A [Recomendada]:** Aplicar as regras de partilha/indenização apenas para itens duráveis da lista de Objetivos (`objetivo`). Itens perecíveis de listas Recorrentes (`recorrente`) são simplesmente baixados do estoque sem gerar indenizações financeiras.
  - **Opção B:** Exigir a partilha formal de todos os itens cadastrados, independentemente do tipo de lista.

---

# Conclusão

A Especificação da Arquitetura de Dados v2.0 corrigida sana 100% dos pontos do seu feedback:
- Remove completamente qualquer conceito de fundo ou caixa coletivo;
- Define a validação pelo responsável pela despesa ou pendência;
- Garante o fluxo em duas vias para rateios avulsos com entrada bancária real;
- Modela a propriedade de bens com cálculo automático de percentuais a partir dos desembolsos e regras de dissolução;
- Apresenta todas as entidades detalhadas campo a campo em centavos inteiros e UIDs estáveis.

O documento normativo completo está preservado no artefato **`arquitetura_de_dados_definitiva_v2.md`**.

Reiterando: **nenhum arquivo de código foi implementado ou alterado.** Aguardo sua análise e a definição das duas decisões pendentes para que possamos, sob sua autorização formal, consolidar a aprovação final.
