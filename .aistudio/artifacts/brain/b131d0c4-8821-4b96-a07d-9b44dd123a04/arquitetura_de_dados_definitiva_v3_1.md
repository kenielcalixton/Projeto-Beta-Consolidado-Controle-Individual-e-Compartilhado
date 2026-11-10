# Especificação da Arquitetura de Dados Definitiva (Versão 3.1)
## Sistema Financeiro Individual, Espaços Compartilhados, Rateios Avulsos, Transferências sob Custódia, Listas de Aquisição com Copropriedade e Livro Oficial de Movimentações

**Documento Oficial de Engenharia de Software, Governança de Dados e Segurança da Informação**  
**Versão:** 3.1 (Revisão Corretiva Consolidada)  
**Data da Revisão:** 09 de Novembro de 2026  
**Status do Documento:** SUBMETIDA PARA AVALIAÇÃO TÉCNICA E HOMOLOGAÇÃO DE NEGÓCIO  
**Autorização de Implementação:** NÃO AUTORIZADA — FASE EXCLUSIVA DE PLANEJAMENTO E ESPECIFICAÇÃO NORMATIVA  
**Compromisso Operacional:** Nenhuma linha de código-fonte (`src/`), componente, banco de dados, coleção ou regra do Firestore foi alterada ou criada.

---

# 1. Visão Geral da Arquitetura e Histórico de Revisões

### 1.1. Propósito do Sistema
O sistema provê uma plataforma unificada, determinística e auditável para controle financeiro pessoal e colaborativo, estruturada em quatro pilares funcionais:
1. **Financeiro Individual:** Orçamento, planejamento de receitas e despesas por competência e vencimento, contas correntes, cartões de crédito, carteiras em espécie e conciliação bancária pessoal.
2. **Espaços Compartilhados:** Governança coletiva para repúblicas, casais e viagens, com despesas rateadas, separação estrita de papéis (autoria, responsabilidade, financiamento e execução), liquidação bilateral e auditoria.
3. **Rateios Avulsos:** Divisão pontual de despesas individuais com terceiros (usuários cadastrados ou devedores externos sem conta no app), com fluxo de convites seguros, recebimentos parciais e baixas manuais.
4. **Listas de Aquisição com Copropriedade:** Abastecimento recorrente com controle de estoque, metas de aquisição com cotações e depósitos vinculados, e desejos de compra, integrados a despesas financeiras com copropriedade proporcional por desembolso real.

---

### 1.2. Relatório Comparativo de Alterações: v3.0 vs. v3.1

| Área / Entidade | O que constava na v3.0 | Problema / Lacuna na v3.0 | Correção Normativa na v3.1 | Status |
| :--- | :--- | :--- | :--- | :---: |
| **Fonte Oficial de Saldos** | Saldo armazenado diretamente em `Account.currentBalanceCents`, atualizado mutavelmente. | Risco de perda de rastreabilidade, divergência contábil e impossibilidade de auditoria e reconstrução. | Criado o **Livro de Movimentações Financeiras (`FinancialMovement`)** como **fonte única da verdade contábil**. O saldo em conta é uma projeção/cache recalculável a partir dos movimentos. | `[APROVADO]` |
| **Exclusão Definitiva de Espaços** | Permitia que qualquer administrador solicitasse a exclusão; prazo de 30 dias com dúvida pendente na UX. | Incompatível com a autoridade do criador; silêncio de autor não estava blindado contra exclusão acidental. | **Exclusiva do Criador (`creatorUid`)**. Prazo estrito de **30 dias**. Se qualquer autor permanecer em `pending`, a solicitação é **automaticamente cancelada**, o espaço permanece arquivado (read-only) e nenhum dado é apagado ou migrado. | `[APROVADO]` |
| **Devedores Externos em Rateios** | Dados de recebimento em array mutável `manualReceiptHistory[]` dentro do devedor; risco de uso em espaços. | Conflito de concorrência no array; duplicidade potencial com reembolsos; proibido em espaços. | `ExternalDebtorRecord` restrito a rateios avulsos. Recebimentos manuais modelados na subcoleção independente `adhoc_receipt_events`. Entrada real de caixa imediata no credor, sem confirmação fictícia do devedor externo. | `[APROVADO]` |
| **Convites por E-mail em Rateios** | Não especificava ciclo de vida de tokens nem transição segura para usuário autenticado. | Risco de criação de obrigações com UID fictício ou sequestro de convite. | Modelada entidade `AdhocInviteToken` com hash criptográfico, uso único, prazo de expiração (15 dias), cancelamento e vinculação atômica ao UID do convidado após autenticação. | `[PROPOSTA TÉCNICA]` |
| **Custódia e Adiantamentos** | Estados ambíguos (`exhausted`); faltava mapear momentos contábeis exatos de entrada/saída. | Sem clareza se o envio já debitava a conta ou se o consumo em despesa gerava nova saída física. | Máquina de estados detalhada com 11 estados explícitos. Mapeamento exato de débitos e créditos: envio debita remetente; confirmação credita custodiante (sob passivo); consumo abate passivo; devolução debita custodiante e credita remetente. | `[APROVADO]` |
| **Recorrências e Parcelamentos** | Apenas citados na v3.0 sem campos, relacionamentos ou regras de integridade. | Impossível garantir não regressão de meses passados ou tratamento de parcelas canceladas. | Especificação exata das 4 entidades (`RecurrenceRule`, `RecurrenceInstance`, `InstallmentContract`, `InstallmentOccurrence`) com chave de idempotência e preservação histórica de competências já consolidadas. | `[PROPOSTA TÉCNICA]` |
| **Aquisições: Propriedade e Custos** | Preço bruto apenas por `quantity * unitPrice`; arrays mutáveis de cotações e depósitos. | Desconsiderava frete, descontos e taxas; histórico de cotações em arrays mutáveis gerava conflito de concorrência. | Custo efetivo formalizado: `totalPaidCents = itemsNet + shipping + fees - discounts`. Cotações e depósitos migrados para subcoleções de eventos independentes (`quotes/`, `deposits/`). | `[APROVADO]` |
| **Segurança e Regras Firestore** | Regras ilustrativas incompletas; brechas em subcoleções e campos sensíveis como `ownerId`. | Subcoleções não herdavam travas; criador ou membro podia alterar dados bancários e de outros membros. | Regras Firestore completas e auditadas cobrindo 100% das coleções e subcoleções, com validação de campos imutáveis, trava de arquivamento e isolamento físico de metadados bancários. | `[PROPOSTA TÉCNICA]` |
| **Conta em Despesas Não Pagas** | `PersonalTransaction.accountId` era obrigatório, mesmo para previsões e dívidas sem conta definida. | Forçava o usuário a associar uma conta bancária antes de decidir como pagaria a despesa. | `accountId` tornado **opcional** enquanto o status for `pending`/`forecast`. Torna-se estritamente obrigatório no ato da confirmação do pagamento (`status: 'paid'`), momento em que o `FinancialMovement` é emitido. | `[APROVADO]` |

---

# 2. Princípios de Domínio e Decisões de Negócio Aprovadas

### 2.1. Princípios Imutáveis de Domínio
1. **D1. Primazia do Histórico de Movimentações:** O histórico de movimentações financeiras (`FinancialMovement`) é o livro-razão canônico e a fonte absoluta da verdade de saldos monetários. Nenhuma conta bancária ou carteira tem seu saldo alterado sem um registro imutável correspondente.
2. **D2. Distinção Rígida em 6 Camadas Operacionais:**
   - *Camada 1 — Obrigação Financeira:* O dever jurídico/contratual de pagar ou receber (ex: aluguel pactuado, cota de rateio apurada).
   - *Camada 2 — Despesa ou Receita Registrada:* O fato gerador econômico por competência (ex: compra realizada, boleto recebido).
   - *Camada 3 — Pagamento/Recebimento Informado:* A declaração unilateral de execução feita por uma das partes (ex: "enviei o PIX").
   - *Camada 4 — Pagamento/Recebimento Confirmado:* O ateste oficial de recebimento dado pelo credor titular (validação do responsável).
   - *Camada 5 — Movimentação Efetiva de Conta/Carteira:* A transação contábil no livro de movimentações com impacto monetário na conta.
   - *Camada 6 — Projeção do Saldo Resultante:* O saldo apurado matematicamente pela consolidação de todos os movimentos históricos.
3. **D3. Inexistência de Caixas Coletivos ou Fundos de Reserva:** Não existem entidades financeiras com personalidade própria no sistema. Recursos coletados antecipadamente constituem **Transferência sob Custódia Pessoal** entre duas pessoas físicas.
4. **D4. Autoridade de Validação do Responsável/Credor:** A validação de qualquer pagamento ou reembolso cabe exclusivamente ao participante a quem o valor é devido (`responsibleUid`). Essa autoridade não é transferível para terceiros nem suplantada pelo criador do espaço.
5. **D5. Inviolabilidade do Consentimento na Exclusão de Espaços:** Somente o criador do espaço pode abrir processo de dissolução definitiva. Cada autor é o único soberano sobre o destino de seus registros autorais. O prazo limite é de **30 dias**. **O silêncio nunca é interpretado como consentimento**. Se houver qualquer autor sem decisão ao final de 30 dias, a solicitação é sumariamente cancelada e o espaço permanece arquivado (read-only), sem qualquer perda ou migração de dados.
6. **D6. Valores Estritamente em Centavos Inteiros:** Todos os valores monetários são inteiros positivos (`SafeInteger` em TypeScript e inteiros de 64 bits no Firestore), representando centavos da moeda BRL (ex: R$ 1.250,90 = `125090`). Elimina erros de ponto flutuante IEEE 754.
7. **D7. Identificação Canônica por UID:** Todas as autorizações e relacionamentos utilizam o UID autenticado pelo Firebase Auth. E-mails são estritamente metadados de contato e comunicação.

---

# 3. Diagrama Completo de Entidades e Relacionamentos

```
┌────────────────────────────────────────────────────────────────────────┐
│                              USUÁRIO (User)                            │
│                  id: uid, email, displayName, createdAt                │
└───────┬──────────────┬──────────────┬──────────────┬─────────────┬─────┘
        │              │              │              │             │
        │ 1:N          │ 1:N          │ 1:N          │ 1:N         │ N:M
        ▼              ▼              ▼              ▼             ▼
┌──────────────┐┌──────────────┐┌──────────────┐┌───────────┐┌───────────┐
│ Conta/       ││ Transação    ││ Transferência││ Orçamento ││ Espaço    │
│ Carteira     ││ Individual   ││ Interna      ││ Pessoal   ││ Compart.  │
│ (Account)    ││(PersonalTx)  ││ (InternalTx) ││ (Budget)  ││ (Space)   │
└───────┬──────┘└──────────────┘└──────────────┘└───────────┘└─────┬─────┘
        │                                                          │
        ├── 1:N ──> Livro Oficial de Movimentações                │
        │           (FinancialMovement)                            │
        │                                                          │
        ├── 1:1 ──> Metadados Bancários Privados                   │
        │           (PrivatePaymentMetadata)                       │
        │                                                          │
        └── 1:N ──> Fatura de Cartão (CreditCardInvoice)           │
                    │                                              │
                    ├── 1:N ──> Pagamento de Fatura                │
                    │           (InvoicePayment)                   │
                    │                                              │
                    └── 1:N ──> Saldo Rolado (InvoiceCarryOver)    │
                                                                   │
    ┌──────────────────────────────────────────────────────────────┘
    │
    ├── 1:N ──> Membro do Espaço (SpaceMember)
    │
    ├── 0:1 ──> Solicitação de Exclusão Definitiva (SpaceDissolutionRequest)
    │           └── 1:N ──> Decisões Individuais de Autores (authorDestinations)
    │
    ├── 1:N ──> Despesa Compartilhada (SharedExpense)
    │           │
    │           ├── 1:N ──> Cota Individual / Obrigação (ExpenseLiability)
    │           │
    │           ├── 1:N ──> Desembolso Reconhecido (ExpensePayment)
    │           │
    │           ├── 1:N ──> Livro-Razão Bilateral Derivado (BilateralDebtLedger)
    │           │
    │           └── 1:N ──> Evento de Estorno de Fornecedor (SupplierRefundEvent)
    │
    └── 1:N ──> Liquidação Bilateral (SettlementRecord)
                │
                ├── 1:N ──> Alocações FIFO de Dívidas (SettlementAllocation)
                │
                └── 1:N ──> Evento de Reversão Contábil (SettlementReversionEvent)

┌────────────────────────────────────────────────────────────────────────┐
│                        TRANSFERÊNCIAS SOB CUSTÓDIA                     │
│                        (transfers/{transferId})                        │
│             senderUid, custodianUid, initialAmountCents, etc.          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    └── 1:N ──> Eventos de Custódia
                                                (CustodyTransferEvent)

┌────────────────────────────────────────────────────────────────────────┐
│                        NÚCLEO DE RATEIOS AVULSOS                       │
│                     (adhoc_expenses/{expenseId})                       │
│            ownerUid, totalAmountCents, ownerShareAmountCents           │
└───────┬────────────────────────────────────────────────────────┬───────┘
        │                                                        │
        ├── 0:N ──> Devedor Externo (Pessoa sem Conta)          ├── 0:N ──> Convidado Cadastrado
        │           (ExternalDebtorRecord)                       │           (AdhocSplitObligation)
        │           │                                            │           │
        │           └── 1:N ──> Evento de Recebimento Manual     │           └── 1:N ──> Reembolso Informado
        │                       (AdhocReceiptEvent)              │                       (AdhocReimbursement)
        │                                                        │
        └── 0:N ──> Token Seguro de Convite (AdhocInviteToken) ──┘

┌────────────────────────────────────────────────────────────────────────┐
│                    LISTAS DE AQUISIÇÃO E COPROPRIEDADE                 │
│                   (acquisition_lists/{listId})                         │
│               scopeType: 'individual' | 'shared', type, etc.           │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    └── 1:N ──> Item da Lista (AcquisitionItem)
                                                │
                                                ├── 1:N ──> Compra Efetiva e Copropriedade
                                                │           (AcquisitionPurchaseRecord)
                                                │
                                                ├── 1:N ──> Cotações de Mercado (AcquisitionQuoteEvent)
                                                │
                                                ├── 1:N ──> Depósitos e Poupança (AcquisitionDepositEvent)
                                                │
                                                └── 1:N ──> Movimentações de Estoque (StockMovementEvent)

┌────────────────────────────────────────────────────────────────────────┐
│                    RECORRÊNCIAS E CONTRATOS PARCELADOS                 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ├── 1:N ──> Regra de Recorrência (RecurrenceRule)
                                    │           └── 1:N ──> Instâncias Geradas (RecurrenceInstance)
                                    │
                                    └── 1:N ──> Contrato Parcelado (InstallmentContract)
                                                └── 1:N ──> Parcelas Geradas (InstallmentOccurrence)
```

---

# 4. Dicionário de Dados Completo

### 4.1. Livro Oficial de Movimentações e Contas

#### `FinancialMovement` (`accounts/{accountId}/movements/{movementId}`)
*Fonte absoluta e canônica da verdade contábil para saldos e conciliações:*
- `id`: string (UUID v4 do movimento, PK)
- `accountId`: string (FK `accounts/{accountId}`)
- `userId`: string (FK `users/{uid}`, titular da conta)
- `direction`: `'inflow' | 'outflow'` (Sentido do recurso financeiro)
- `amountCents`: number (Valor estritamente positivo em centavos inteiros)
- `effectiveDate`: string (Data do efetivo débito/crédito bancário, YYYY-MM-DD)
- `registeredAt`: string (Timestamp ISO da gravação no sistema)
- `originType`: `'personal_expense' | 'personal_income' | 'internal_transfer_in' | 'internal_transfer_out' | 'credit_card_payment' | 'adhoc_receipt' | 'custody_deposit' | 'custody_withdrawal' | 'custody_return' | 'settlement_inflow' | 'settlement_outflow' | 'supplier_refund' | 'manual_adjustment'`
- `originId`: string (ID do documento que motivou a movimentação, ex: `txId`, `transferId`, `settlementId`, `paymentId`)
- `confirmationStatus`: `'cleared' | 'reconciled'` (Status contábil de liquidação/conciliação bancária. Imutável após gravação)
- `idempotencyKey`: string (Chave de unicidade: `originType_originId_direction_suffix`)
- `reversalOfMovementId`?: string (Presente exclusivamente em movimentos compensatórios; referencia o `movementId` original que está sendo anulado)
- `description`: string (Rótulo explicativo para o extrato)
- `notes`?: string (Justificativa contábil, obrigatória em ajustes manuais)
- `authorUid`: string (Quem comandou a operação)

#### `Account` (`accounts/{accountId}`)
*Representação de contas correntes, contas salário, poupanças, carteiras e cartões:*
- `id`: string (PK)
- `userId`: string (FK `users/{uid}`)
- `name`: string (Ex: "Nubank Principal", "Itaú Salário", "Carteira Dinheiro")
- `type`: `'checking' | 'credit' | 'wallet' | 'savings'`
- `projectedBalanceCents`: number (Cache calculado a partir de `FinancialMovement`. Nunca atualizado sem movimento)
- `creditLimitCents`?: number (Limite total para cartões de crédito)
- `closingDay`?: number (1 a 31, dia de fechamento da fatura de cartão)
- `dueDay`?: number (1 a 31, dia de vencimento da fatura de cartão)
- `color`: string (Hex code)
- `icon`: string
- `isArchived`: boolean (Se true, não recebe novas operações)
- `createdAt`: string (ISO)
- `updatedAt`: string (ISO)

#### `PrivatePaymentMetadata` (`accounts/{accountId}/private_payment_metadata/{paymentId}`)
*Dados bancários confidenciais e comprovantes privados (isolamento físico estrito):*
- `id`: string (PK)
- `accountId`: string (FK)
- `userId`: string (FK)
- `bankName`: string (Ex: "Banco Bradesco S.A.")
- `agencyNumber`?: string
- `accountNumber`?: string
- `pixKey`?: string
- `receiptStorageUrl`?: string (Caminho seguro no Cloud Storage)
- `createdAt`: string (ISO)

#### `CreditCardInvoice` (`accounts/{accountId}/invoices/{invoiceMonth}`)
*Competência mensal da fatura de cartão de crédito (YYYY-MM):*
- `id`: string (PK: formato `YYYY-MM`, ex: "2026-11")
- `accountId`: string (FK `accounts/{accountId}`)
- `userId`: string (FK `users/{uid}`)
- `invoiceMonth`: string (YYYY-MM)
- `closingDate`: string (YYYY-MM-DD)
- `dueDate`: string (YYYY-MM-DD)
- `totalPurchasesAmountCents`: number (Soma de despesas alocadas a esta fatura)
- `carriedOverBalanceCents`: number (Saldo principal não pago trazido da fatura anterior)
- `interestAndFeesCents`: number (Encargos, juros de mora e multas contratuais)
- `totalDueAmountCents`: number (`totalPurchases + carriedOver + interestAndFees`)
- `totalPaidAmountCents`: number (Soma de amortizações recebidas)
- `remainingBalanceCents`: number (`totalDueAmountCents - totalPaidAmountCents`)
- `invoiceStatus`: `'open' | 'closed' | 'partially_paid' | 'paid' | 'overdue'`
- `updatedAt`: string (ISO)

#### `InvoicePayment` (`accounts/{accountId}/invoices/{invoiceMonth}/payments/{paymentId}`)
*Amortização da fatura com débito em conta corrente ou carteira:*
- `id`: string (PK)
- `invoiceMonth`: string (FK)
- `accountId`: string (FK cartão)
- `sourceAccountId`: string (FK da conta corrente/carteira debitada)
- `amountPaidCents`: number
- `paymentDate`: string (YYYY-MM-DD)
- `financialMovementId`: string (FK `FinancialMovement` gerado na conta pagadora)
- `clientTransactionUuid`: string
- `createdAt`: string (ISO)

#### `PersonalTransaction` (`users/{userId}/personal_transactions/{txId}`)
*Despesas, receitas e previsões individuais:*
- `id`: string (PK)
- `userId`: string (FK `users/{uid}`)
- `description`: string
- `amountCents`: number
- `type`: `'income' | 'expense'`
- `status`: `'forecast' | 'pending' | 'paid' | 'overdue' | 'cancelled'`
- `categoryId`: string (FK `categories/{categoryId}`)
- `categoryName`: string
- `accountId`?: string (FK `accounts/{accountId}`. **Opcional** se `forecast`/`pending`; **obrigatório** se `paid`)
- `competenceDate`: string (YYYY-MM-DD)
- `dueDate`: string (YYYY-MM-DD)
- `paymentDate`?: string (YYYY-MM-DD)
- `invoiceMonth`?: string (Preenchido se pago via cartão de crédito, YYYY-MM)
- `financialMovementId`?: string (FK `FinancialMovement`, gerado quando `status == 'paid'`)
- `originType`: `'manual' | 'shopping_list' | 'recurrence' | 'installment'`
- `originRefId`?: string
- `idempotencyKey`: string
- `createdAt`: string (ISO)

---

### 4.2. Rateios Avulsos e Pessoas Externas

#### `AdhocSplitExpense` (`adhoc_expenses/{expenseId}`)
*Despesa individual compartilhada pontualmente com terceiros:*
- `id`: string (PK)
- `ownerUid`: string (Autor do cadastro e credor primário)
- `ownerName`: string
- `title`: string
- `description`?: string
- `totalAmountCents`: number (Valor bruto original)
- `ownerShareAmountCents`: number (Parte que cabe ao autor)
- `totalToReimburseCents`: number (`totalAmountCents - ownerShareAmountCents`)
- `totalReimbursedCents`: number (Total de reembolsos recebidos e confirmados)
- `remainingToReimburseCents`: number (`totalToReimburse - totalReimbursed`)
- `fundingSource`: `'personal_checking' | 'credit_card' | 'wallet'`
- `sourceAccountId`: string (Conta/cartão do autor de onde saiu o dinheiro)
- `financialMovementId`?: string (Movimento de débito na conta do autor, se aplicável)
- `date`: string (YYYY-MM-DD)
- `status`: `'active' | 'partially_reimbursed' | 'fully_reimbursed' | 'cancelled'`
- `hasRegisteredDebtors`: boolean
- `hasExternalDebtors`: boolean
- `createdAt`: string (ISO)

#### `ExternalDebtorRecord` (`adhoc_expenses/{expenseId}/external_debtors/{debtorId}`)
*Pessoa externa sem conta no app (Exclusivo para rateios avulsos, vedado em espaços):*
- `id`: string (PK)
- `adhocExpenseId`: string (FK)
- `name`: string (Nome fornecido pelo autor, ex: "Carlos Mecânico")
- `identificationType`: `'name_only' | 'email_invited'`
- `email`?: string (Se houver e-mail para envio de convite seguro)
- `assignedAmountCents`: number (Valor devido)
- `totalReimbursedCents`: number (Soma dos eventos de recebimento manual)
- `remainingBalanceCents`: number (`assignedAmountCents - totalReimbursedCents`)
- `debtorStatus`: `'pending' | 'partially_cleared' | 'cleared' | 'cancelled'`
- `inviteTokenId`?: string (FK `AdhocInviteToken`, se convite enviado)
- `migratedToUid`?: string (UID do usuário caso tenha aceitado o convite e se cadastrado)
- `createdAt`: string (ISO)

#### `AdhocReceiptEvent` (`adhoc_expenses/{expenseId}/external_debtors/{debtorId}/receipt_events/{eventId}`)
*Subcoleção independente para histórico auditável de recebimentos manuais (eliminando arrays mutáveis):*
- `id`: string (PK)
- `debtorId`: string (FK)
- `adhocExpenseId`: string (FK)
- `amountCents`: number
- `receivedDate`: string (YYYY-MM-DD)
- `destinationAccountId`: string (Conta corrente ou carteira do credor onde entrou o dinheiro)
- `registeredByUid`: string (Autor que deu a baixa manual)
- `financialMovementId`: string (FK `FinancialMovement` gerado na conta do credor)
- `notes`?: string (Ex: "Recebido em cédulas no almoço")
- `createdAt`: string (ISO)

#### `AdhocInviteToken` (`adhoc_invites/{tokenId}`)
*Token seguro para associação de convidados que se cadastram após o rateio:*
- `id`: string (PK: hash criptográfico SHA-256 do token gerado)
- `adhocExpenseId`: string (FK)
- `debtorRecordId`: string (FK `ExternalDebtorRecord`)
- `invitedEmail`: string
- `assignedAmountCents`: number
- `creatorUid`: string
- `expiresAt`: string (Timestamp ISO, validade padrão de 15 dias)
- `tokenStatus`: `'pending' | 'accepted' | 'expired' | 'revoked'`
- `acceptedByUid`?: string (UID verificado no Firebase Auth)
- `acceptedAt`?: string (ISO)
- `createdAt`: string (ISO)

#### `AdhocSplitObligation` (`users/{guestUid}/adhoc_obligations/{obligationId}`)
*Conta a pagar visível no painel do convidado autenticado no app:*
- `id`: string (PK)
- `adhocExpenseId`: string (FK)
- `guestUid`: string (FK titular da obrigação)
- `creditorUid`: string (FK autor do rateio)
- `creditorName`: string
- `assignedAmountCents`: number
- `paidAmountCents`: number (Soma de amortizações informadas e confirmadas)
- `remainingBalanceCents`: number (`assignedAmountCents - paidAmountCents`)
- `obligationStatus`: `'pending_invite' | 'accepted' | 'rejected' | 'partially_paid' | 'payment_informed' | 'confirmed_cleared'`
- `guestRejectionReason`?: string
- `updatedAt`: string (ISO)

#### `AdhocReimbursement` (`adhoc_expenses/{expenseId}/reimbursements/{reimbursementId}`)
*Evento de liquidação de rateio avulso por usuário cadastrado:*
- `id`: string (PK)
- `adhocExpenseId`: string (FK)
- `obligationId`: string (FK `AdhocSplitObligation`)
- `debtorUid`: string (Quem pagou)
- `creditorUid`: string (Quem recebe)
- `amountCents`: number
- `paymentDate`: string (YYYY-MM-DD)
- `paymentProofUrl`?: string
- `status`: `'pending_confirmation' | 'confirmed' | 'rejected'`
- `destinationAccountId`?: string (Conta escolhida pelo credor no ato da validação)
- `financialMovementId`?: string (FK `FinancialMovement` de entrada na conta do credor)
- `confirmedAt`?: string (ISO)
- `rejectionReason`?: string
- `createdAt`: string (ISO)

---

### 4.3. Espaços Compartilhados, Governança e Dissolução Definitiva

#### `Space` (`spaces/{spaceId}`)
*Entidade central de governança do grupo coletivo:*
- `id`: string (PK)
- `creatorUid`: string (FK `users/{uid}`, autoridade exclusiva para solicitar dissolução)
- `ownerId`: string (FK `users/{uid}`, administrador técnico)
- `name`: string
- `description`?: string
- `icon`: string
- `color`: string
- `spaceStatus`: `'active' | 'archived' | 'pending_dissolution' | 'dissolved'`
- `archivedAt`?: string (ISO)
- `archivedByUid`?: string (FK `users/{uid}`)
- `memberUids`: string[] (Array sincronizado e canônico de membros ativos)
- `enabledModules`: Array<`'finance' | 'acquisitions'`>
- `monthlyBudgetCents`?: number
- `createdAt`: string (ISO)

#### `SpaceMember` (`spaces/{spaceId}/members/{memberUid}`)
*Participação e papel de cada participante no espaço:*
- `id`: string (PK: `memberUid`)
- `spaceId`: string (FK)
- `uid`: string (FK `users/{uid}`)
- `displayName`: string
- `contactEmail`: string
- `role`: `'owner' | 'admin' | 'member'`
- `participationStatus`: `'invited' | 'active' | 'voluntary_exit' | 'removed_by_admin' | 'declined'`
- `invitedAt`: string (ISO)
- `joinedAt`?: string (ISO)
- `exitedAt`?: string (ISO)

#### `SpaceDissolutionRequest` (`spaces/{spaceId}/dissolution/request`)
*Processo formal e restrito de exclusão definitiva com destinação individual:*
- `id`: string (PK: "request")
- `spaceId`: string (FK)
- `initiatedByUid`: string (Deve ser estritamente igual ao `creatorUid` do espaço)
- `initiatedAt`: string (ISO)
- `deadlineDate`: string (Data exata de expiração = `initiatedAt + 30 dias`, ISO)
- `requestStatus`: `'pending_author_responses' | 'fully_approved_ready' | 'auto_cancelled_timeout' | 'cancelled_by_creator' | 'executed'`
- `totalRecordsAudit`: {
    `expensesCount`: number;
    `paymentsCount`: number;
    `listsCount`: number;
    `itemsCount`: number;
    `custodyTransfersCount`: number;
  }
- `authorDestinations`: {
    [authorUid: string]: {
      `decision`: `'pending' | 'migrate_to_existing_personal_space' | 'create_personal_space_and_migrate' | 'archive_or_hide' | 'delete_permanently'`;
      `targetSpaceId`?: string;
      `decidedAt`?: string;
    };
  }
- `cancelledAt`?: string (ISO)
- `cancellationReason`?: string

#### `SharedExpense` (`spaces/{spaceId}/shared_expenses/{expenseId}`)
*Despesa coletiva com segregação de autoria e responsabilidade:*
- `id`: string (PK)
- `spaceId`: string (FK)
- `title`: string
- `description`?: string
- `totalOriginalAmountCents`: number (Valor bruto da obrigação perante o credor/fornecedor)
- `competenceMonth`: string (YYYY-MM)
- `competenceDate`: string (YYYY-MM-DD)
- `dueDate`?: string (YYYY-MM-DD)
- `categoryId`: string
- `categoryName`: string
- `createdByUid`: string (Autor do lançamento no app)
- `responsibleUid`: string (Responsável financeiro primário e credor das cotas)
- `validationStatus`: `'pending_validation' | 'approved' | 'rejected' | 'cancelled'`
- `validatedByUid`?: string (O `responsibleUid` que deu o aceite oficial)
- `validatedAt`?: string
- `rejectionReason`?: string
- `commitmentStatus`: `'active' | 'closed' | 'cancelled_pre_payment' | 'loss_unrecoverable'`
- `paymentExecutionStatus`: `'unpaid' | 'partially_paid' | 'fully_paid'`
- `totalPaidToSupplierCents`: number (Valor desembolsado ao fornecedor)
- `originType`: `'manual' | 'shopping_list' | 'installment' | 'recurrence'`
- `originRefId`?: string
- `idempotencyKey`: string
- `createdAt`: string (ISO)

#### `ExpenseLiability` (`spaces/{spaceId}/shared_expenses/{expenseId}/liabilities/{memberUid}`)
*Cota de responsabilidade de cada participante no rateio:*
- `id`: string (PK: `memberUid`)
- `expenseId`: string (FK)
- `spaceId`: string (FK)
- `memberUid`: string (FK)
- `memberName`: string
- `assignedShareAmountCents`: number (Cota bruta calculada)
- `adjustedShareAmountCents`: number (Cota líquida após estornos/descontos de fornecedor)
- `splitMethod`: `'equal' | 'percentage' | 'custom_value'`
- `splitRatio`?: number
- `roundingRemainderRank`?: number (Critério Hamilton/Hare)

#### `ExpensePayment` (`spaces/{spaceId}/shared_expenses/{expenseId}/payments/{paymentId}`)
*Desembolso ao fornecedor com identificação de executor e financiador:*
- `id`: string (PK)
- `expenseId`: string (FK)
- `spaceId`: string (FK)
- `amountCents`: number
- `paymentDate`: string (YYYY-MM-DD)
- `executedByUid`: string (Quem entregou o recurso ao fornecedor)
- `economicFunderUid`: string (Quem disponibilizou o dinheiro próprio ou de custódia)
- `fundingSource`: `'personal_checking' | 'credit_card' | 'wallet' | 'custody_transfer'`
- `custodyTransferId`?: string (FK `transfers/{transferId}`, se custódia)
- `publicPayerLabel`: string (Rótulo público exibido aos membros, ex: "Recurso próprio de João")
- `validationStatus`: `'pending_validation' | 'approved' | 'rejected'`
- `validatedByUid`?: string (O `responsibleUid` da despesa valida o desembolso)
- `financialMovementId`?: string (Gerado na conta privada do `economicFunderUid`)
- `clientTransactionUuid`: string
- `createdAt`: string (ISO)

#### `BilateralDebtLedger` (`spaces/{spaceId}/shared_expenses/{expenseId}/bilateral_debts/{debtId}`)
*Projeção determinística de saldos bilaterais constituídos por despesa:*
- `id`: string (PK: `${debtorUid}_${creditorUid}`)
- `expenseId`: string (FK)
- `spaceId`: string (FK)
- `competenceMonth`: string (YYYY-MM)
- `debtorUid`: string (Participante devedor de sua cota)
- `creditorUid`: string (Participante que financiou a despesa além de sua cota)
- `originalFinancedAmountCents`: number
- `liquidatedCents`: number (Amortizado por `SettlementRecord`)
- `currentRemainingDebtCents`: number (`originalFinanced - liquidated`)
- `status`: `'open' | 'partially_settled' | 'fully_settled'`

#### `SettlementRecord` (`spaces/{spaceId}/settlements/{settlementId}`)
*Liquidação bilateral de dívidas entre dois membros:*
- `id`: string (PK)
- `spaceId`: string (FK)
- `debtorUid`: string (Quem transfere o dinheiro de acerto)
- `creditorUid`: string (Quem recebe o dinheiro)
- `amountSettledCents`: number
- `settlementDate`: string (YYYY-MM-DD)
- `paymentDeclarationProofUrl`?: string
- `destinationAccountId`?: string (Conta escolhida pelo credor para entrada)
- `sourceAccountId`?: string (Conta de onde o devedor enviou)
- `status`: `'pending_confirmation' | 'confirmed' | 'rejected' | 'reverted'`
- `confirmedAt`?: string
- `confirmedByUid`?: string (Validação do credor)
- `financialMovementInflowId`?: string (Entrada na conta do credor)
- `financialMovementOutflowId`?: string (Saída na conta do devedor)
- `clientTransactionUuid`: string
- `createdAt`: string (ISO)

#### `SettlementAllocation` (`spaces/{spaceId}/settlements/{settlementId}/allocations/{allocationId}`)
*Amortização FIFO de cada dívida bilateral vinculada à liquidação:*
- `id`: string (PK)
- `settlementId`: string (FK)
- `bilateralDebtId`: string (FK `BilateralDebtLedger/{debtId}`)
- `expenseId`: string (FK `SharedExpense/{expenseId}`)
- `competenceMonth`: string (YYYY-MM)
- `amountAllocatedCents`: number

#### `SettlementReversionEvent` (`spaces/{spaceId}/settlements/{settlementId}/reversions/{reversionId}`)
*Estorno contábil de liquidação com preservação do histórico:*
- `id`: string (PK)
- `settlementId`: string (FK)
- `requestedByUid`: string
- `confirmedByUid`: string
- `revertReason`: string
- `reversalMovementInflowId`?: string (Estorno do crédito do credor)
- `reversalMovementOutflowId`?: string (Estorno do débito do devedor)
- `revertedAt`: string (ISO)

---

### 4.4. Transferências sob Custódia e Adiantamentos

#### `CustodyTransfer` (`transfers/{transferId}`)
*Contrato bilateral de adiantamento e custódia pessoal:*
- `id`: string (PK)
- `scopeType`: `'shared_space' | 'direct_bilateral'`
- `spaceId`?: string (FK `spaces/{spaceId}`, se vinculado a espaço)
- `senderUid`: string (Remetente do recurso)
- `custodianUid`: string (Custodiante titular da conta onde o dinheiro entra)
- `initialAmountCents`: number (Valor transferido)
- `usedAmountCents`: number (Total abatido em despesas compartilhadas)
- `returnedAmountCents`: number (Total devolvido voluntariamente ao remetente)
- `availableBalanceCents`: number (`initial - used - returned`)
- `sourceAccountId`: string (Conta do remetente de onde saiu o recurso)
- `destinationAccountId`?: string (Conta do custodiante onde entrou o recurso)
- `custodyStatus`: `'pending_receipt' | 'available' | 'partially_used' | 'fully_used' | 'partial_return_pending' | 'partial_return_confirmed' | 'full_return_pending' | 'full_return_confirmed' | 'settled_by_usage' | 'settled_by_return' | 'settled_by_mixed'`
- `createdAt`: string (ISO)
- `updatedAt`: string (ISO)

#### `CustodyTransferEvent` (`transfers/{transferId}/events/{eventId}`)
*Subcoleção imutável de eventos da custódia:*
- `id`: string (PK)
- `transferId`: string (FK)
- `eventType`: `'transfer_declared' | 'receipt_confirmed' | 'expense_consumed' | 'return_requested' | 'return_confirmed' | 'adjustment_reverted'`
- `amountCents`: number
- `targetExpenseId`?: string (FK `SharedExpense`, se consumo)
- `affectedAccountId`?: string (Conta bancária movimentada)
- `financialMovementId`?: string (FK `FinancialMovement` gerado no evento)
- `performedByUid`: string
- `justification`?: string
- `clientTransactionUuid`: string
- `timestamp`: string (ISO)

---

### 4.5. Recorrências e Parcelamentos Desacoplados

#### `RecurrenceRule` (`recurrence_rules/{ruleId}`)
*Regra mestra geradora de despesas ou receitas periódicas:*
- `id`: string (PK)
- `scope`: `'personal' | 'shared'`
- `userId`: string (FK `users/{uid}`, criador da regra)
- `spaceId`?: string (FK `spaces/{spaceId}`, se compartilhada)
- `title`: string
- `description`?: string
- `amountCents`: number (Valor base estimado por competência)
- `frequency`: `'monthly' | 'weekly' | 'yearly'`
- `interval`: number (Ex: 1 = todo mês; 2 = bimestral)
- `startCompetence`: string (YYYY-MM)
- `endCompetence`?: string (YYYY-MM, opcional se indeterminada)
- `dueDay`: number (1 a 31)
- `categoryId`: string
- `defaultAccountId`?: string
- `status`: `'active' | 'paused' | 'cancelled'`
- `createdAt`: string (ISO)

#### `RecurrenceInstance` (`recurrence_rules/{ruleId}/instances/{competenceMonth}`)
*Instância de competência concreta gerada pela regra:*
- `id`: string (PK: formato `YYYY-MM`)
- `ruleId`: string (FK)
- `competenceMonth`: string (YYYY-MM)
- `generatedTransactionId`?: string (FK `PersonalTransaction`)
- `generatedExpenseId`?: string (FK `SharedExpense`)
- `generationStatus`: `'pending' | 'generated' | 'skipped'`
- `actualAmountCents`: number
- `generatedAt`: string (ISO)

#### `InstallmentContract` (`installment_contracts/{contractId}`)
*Contrato mestre de compra ou obrigação parcelada:*
- `id`: string (PK)
- `scope`: `'personal' | 'shared'`
- `userId`: string (FK)
- `spaceId`?: string (FK)
- `title`: string
- `totalContractAmountCents`: number (Valor total financiado)
- `totalInstallmentsCount`: number (Número total de parcelas, ex: 12)
- `fundingSource`: `'credit_card' | 'personal_loan'`
- `sourceCardAccountId`?: string
- `startCompetenceMonth`: string (YYYY-MM)
- `status`: `'active' | 'completed' | 'cancelled_early'`
- `cancellationReason`?: string
- `createdAt`: string (ISO)

#### `InstallmentOccurrence` (`installment_contracts/{contractId}/occurrences/{installmentNumber}`)
*Parcela individual com preservação histórica de competência:*
- `id`: string (PK: número da parcela, ex: "01", "02")
- `contractId`: string (FK)
- `installmentNumber`: number
- `competenceMonth`: string (YYYY-MM)
- `principalAmountCents`: number
- `interestAmountCents`: number
- `totalInstallmentAmountCents`: number
- `linkedTransactionId`?: string (FK `PersonalTransaction`)
- `linkedExpenseId`?: string (FK `SharedExpense`)
- `status`: `'scheduled' | 'billed' | 'paid' | 'cancelled'`
- `dueDate`: string (YYYY-MM-DD)

---

### 4.6. Listas de Aquisição com Propriedade por Compra Efetiva

#### `AcquisitionList` (`acquisition_lists/{listId}`)
*Lista de aquisição categorizada:*
- `id`: string (PK)
- `scopeType`: `'individual' | 'shared'`
- `ownerUid`: string (FK titular se individual)
- `spaceId`?: string (FK espaço se compartilhada)
- `name`: string
- `description`?: string
- `type`: `'recorrente' | 'objetivo' | 'desejo'`
- `memberUids`: string[] (Array para controle de leitura/escrita)
- `createdByUid`: string
- `createdAt`: string (ISO)

#### `AcquisitionItem` (`acquisition_lists/{listId}/items/{itemId}`)
*Item catalogado na lista:*
- `id`: string (PK)
- `listId`: string (FK)
- `scopeType`: `'individual' | 'shared'`
- `ownerUid`?: string
- `spaceId`?: string
- `name`: string
- `groupId`: string
- `categoryId`: string
- `listType`: `'recorrente' | 'objetivo' | 'desejo'`
- `stage`: string (Estágio Kanban)
- `currentStock`: number (Recorrente)
- `minStock`: number (Recorrente)
- `unit`: `'un' | 'kg' | 'L' | 'pct' | 'cx'` (Recorrente)
- `targetAmountCents`?: number (Objetivo)
- `estimatedPriceCents`?: number (Desejo)
- `priority`?: `'Baixa' | 'Média' | 'Alta'` (Desejo)
- `inspirationUrl`?: string (Desejo)
- `notes`?: string
- `createdByUid`: string
- `createdAt`: string (ISO)
- `updatedAt`: string (ISO)

#### `AcquisitionPurchaseRecord` (`acquisition_lists/{listId}/items/{itemId}/purchases/{purchaseId}`)
*Registro de compra efetiva com governança de copropriedade imutável:*
- `id`: string (PK)
- `itemId`: string (FK)
- `listId`: string (FK)
- `spaceId`?: string (FK)
- `physicalBuyerUid`: string (Quem realizou fisicamente a transação na loja)
- `authorUid`: string (Quem registrou o checkout no sistema)
- `storeName`: string
- `brand`?: string
- `quantity`: number
- `unitPriceCents`: number
- `itemsNetCents`: number (`quantity * unitPriceCents`)
- `shippingCents`: number (Frete alocado ao item)
- `feesCents`: number (Taxas e acréscimos)
- `discountsCents`: number (Descontos promocionais obtidos)
- `totalPaidCents`: number (`itemsNetCents + shippingCents + feesCents - discountsCents`)
- `purchaseDate`: string (ISO)
- `receiptUrl`?: string
- `ownershipClassification`: `'individual' | 'shared_participants' | 'space_asset'`
- `disbursements`: Array<{
    `funderUid`: string;
    `funderName`: string;
    `disbursedAmountCents`: number;
    `fundingSource`: `'checking' | 'credit_card' | 'wallet' | 'custody'`;
    `sourceAccountId`?: string;
  }>
- `ownershipShares`: Array<{
    `uid`: string;
    `name`: string;
    `disbursedAmountCents`: number;
    `ownershipPercentage`: number; // (disbursed / totalPaid) * 100
  }>
- `linkedExpenseId`: string (FK `SharedExpense` ou `PersonalTransaction`)
- `linkedExpenseType`: `'personal' | 'shared'`
- `idempotencyKey`: string
- `createdAt`: string (ISO)

#### `AcquisitionQuoteEvent` (`acquisition_lists/{listId}/items/{itemId}/quotes/{quoteId}`)
*Cotação de mercado independente (eliminando array mutável `quotes[]`):*
- `id`: string (PK)
- `itemId`: string (FK)
- `storeName`: string
- `priceCents`: number
- `url`?: string
- `validUntil`?: string (YYYY-MM-DD)
- `authorUid`: string
- `createdAt`: string (ISO)

#### `AcquisitionDepositEvent` (`acquisition_lists/{listId}/items/{itemId}/deposits/{depositId}`)
*Depósito de poupança para meta de compra (eliminando array mutável `deposits[]`):*
- `id`: string (PK)
- `itemId`: string (FK)
- `contributorUid`: string
- `amountCents`: number
- `sourceAccountId`: string
- `financialMovementId`: string (Débito da conta pessoal poupadora)
- `depositDate`: string (YYYY-MM-DD)
- `notes`?: string
- `createdAt`: string (ISO)

#### `StockMovementEvent` (`acquisition_lists/{listId}/items/{itemId}/stock_movements/{movementId}`)
*Histórico auditável de estoque para itens recorrentes:*
- `id`: string (PK)
- `itemId`: string (FK)
- `movementType`: `'purchase_inflow' | 'manual_adjustment' | 'consumption_outflow'`
- `quantityDelta`: number (Positivo para entrada, negativo para consumo)
- `previousStock`: number
- `newStock`: number
- `authorUid`: string
- `justification`?: string
- `createdAt`: string (ISO)

---

# 5. Estados e Transições de Cada Fluxo

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        MÁQUINAS DE ESTADO REVISADAS (v3.1)                             │
├───────────────────────────────┬────────────────────────────────────────────────────────┤
│ 1. ESTADO DO ESPAÇO           │ [active] ──(Arquivar pelo criador/owner)──> [archived]  │
│                               │    │                                            │      │
│                               │    └──(Solicitar exclusão)                      │      │
│                               │            ▼                                    │      │
│                               │    [pending_dissolution]                        │      │
│                               │         ├──(Falta de resposta após 30 dias)─────┘      │
│                               │         ├──(Cancelamento pelo criador)──────────┘      │
│                               │         └──(Todos responderam e consentiram)          │
│                               │                    ▼                                   │
│                               │               [dissolved] (Exclusão física executada)  │
├───────────────────────────────┼────────────────────────────────────────────────────────┤
│ 2. RESPOSTA DO AUTOR NA       │ [pending]                                              │
│    DISSOLUÇÃO (Individual)    │    ├──(Migrar p/ individual existente)                 │
│                               │    ├──(Criar novo espaço pessoal e migrar)             │
│                               │    ├──(Arquivar como histórico pessoal oculto)         │
│                               │    └──(Excluir permanentemente seus registros)         │
├───────────────────────────────┼────────────────────────────────────────────────────────┤
│ 3. RATEIO AVULSO EXTERNO      │ [pending]                                              │
│    (Pessoa sem Cadastro)      │    ├──(Recebimento parcial registrado)──> [partially_cleared]
│                               │    └──(Recebimento total registrado)───> [cleared]     │
├───────────────────────────────┼────────────────────────────────────────────────────────┤
│ 4. OBRIGAÇÃO CONVIDADO APP    │ [pending_invite] ──(Aceitar)──> [accepted]             │
│    (Rateio Avulso Cadastrado) │    ├──(Recusar)──> [rejected]       │                  │
│                               │    │                                ├──(Pagar parcial)─> [partially_paid]
│                               │    │                                └──(Informar PIX)──> [payment_informed]
│                               │    │                                                          │
│                               │    │                                                          └──(Credor confirma)──> [confirmed_cleared]
├───────────────────────────────┼────────────────────────────────────────────────────────┤
│ 5. CUSTÓDIA DE ADIANTAMENTO   │ [pending_receipt] ──(Custodiante confirma)──> [available]
│    (11 Estados Explícitos)    │                                                     │
│                               │         ┌──(Consumo parcial em despesa)─────────────┼──> [partially_used]
│                               │         │                                           │         │
│                               │         ├──(Consumo total em despesa)───────────────┼──> [fully_used] ──> [settled_by_usage]
│                               │         │                                           │
│                               │         ├──(Solicita devolução parcial)─────────────┼──> [partial_return_pending]
│                               │         │   └──(Confirma devolução parcial)─────────┴──> [partial_return_confirmed]
│                               │         │
│                               │         └──(Solicita devolução total)───────────────┬──> [full_return_pending]
│                               │             └──(Confirma devolução total)───────────┴──> [full_return_confirmed] ──> [settled_by_return]
│                               │
│                               │   (Se saldo zerou por consumo + devolução) ────────────> [settled_by_mixed]
└───────────────────────────────┴────────────────────────────────────────────────────────┘
```

---

# 6. Regras de Integridade Financeira e Contábil

### 6.1. Equações Fundamentais de Integridade

1. **Equação do Livro de Movimentações e Reconstrução de Saldo:**
   $$\text{projectedBalanceCents}(A) = \sum_{m \in \mathcal{M}_{\text{in}}(A)} \text{amountCents}_m - \sum_{m \in \mathcal{M}_{\text{out}}(A)} \text{amountCents}_m$$
   Onde $\mathcal{M}_{\text{in}}(A)$ e $\mathcal{M}_{\text{out}}(A)$ são os movimentos de entrada e saída com `confirmationStatus \in \{'cleared', 'reconciled'\}` vinculados à conta $A$.

2. **Equação de Rateio Exato de Despesas Compartilhadas:**
   $$\sum_{k=1}^n \text{assignedShareAmountCents}_k = \text{totalOriginalAmountCents}$$
   O centavo residual decorrente de divisões não exatas é alocado pelo método Hamilton/Hare com base no ranking de restos decrescentes.

3. **Equação de Custo Efetivo e Copropriedade de Bens Adquiridos:**
   $$\text{totalPaidCents} = \text{itemsNetCents} + \text{shippingCents} + \text{feesCents} - \text{discountsCents}$$
   $$\sum_{i=1}^m \text{disbursedAmountCents}_i = \text{totalPaidCents}$$
   $$\text{ownershipPercentage}_i = \left( \frac{\text{disbursedAmountCents}_i}{\text{totalPaidCents}} \right) \times 100$$
   $$\sum_{i=1}^m \text{ownershipPercentage}_i = 100.00\%$$

4. **Equação do Saldo Disponível de Custódia:**
   $$\text{availableBalanceCents} = \text{initialAmountCents} - (\text{usedAmountCents} + \text{returnedAmountCents})$$
   $$\text{availableBalanceCents} \ge 0 \quad (\text{Invariante: Saldo nunca pode ser negativo})$$

5. **Equação de Fatura de Cartão de Crédito:**
   $$\text{totalDueAmountCents} = \text{totalPurchasesAmountCents} + \text{carriedOverBalanceCents} + \text{interestAndFeesCents}$$
   $$\text{remainingBalanceCents} = \text{totalDueAmountCents} - \text{totalPaidAmountCents}$$

---

# 7. Modelo Oficial de Movimentações e Cálculo de Saldos

### 7.1. Separação de Conceitos Contábeis
- **Despesa Não Paga (`PersonalTransaction.status == 'pending'` ou `SharedExpense.paymentExecutionStatus == 'unpaid'`):** Não afeta o caixa. Não emite `FinancialMovement`. É uma obrigação registrada em competência.
- **Pagamento Efetivado:** Gera um `FinancialMovement` com `direction: 'outflow'` na conta do pagador, com data efetiva e vínculo com a despesa.
- **Transferência entre Contas Próprias:** Gera **dois** registros de `FinancialMovement` atômicos em transação Firestore:
  1. `direction: 'outflow'` na conta de origem;
  2. `direction: 'inflow'` na conta de destino;
  Ambos compartilham o mesmo `originId` e chave de idempotência cruzada.
- **Pagamento de Fatura de Cartão:** Gera `direction: 'outflow'` na conta corrente pagadora. **Não gera despesa nova**, pois os itens da fatura já foram apropriados contabilmente como despesas na competência da compra.
- **Reembolso Recebido:** Gera `direction: 'inflow'` na conta bancária ou carteira escolhida pelo credor, recompondo o caixa sem alterar os valores históricos da compra original no cartão.
- **Estorno ou Cancelamento Posterior (Modelo Append-Only Estrito):** O `FinancialMovement` original **nunca é alterado nem deletado** (mantém-se 100% imutável, preservando `allow update: if false; allow delete: if false;`). Para reverter seus efeitos, o sistema emite um **novo movimento compensatório** com `direction` oposta, mesmo valor em centavos e o campo `reversalOfMovementId` referenciando o ID do movimento original.

### 7.2. Algoritmo de Reconstrução e Conciliação de Saldos
Como o livro-razão opera no modelo contábil de partidas dobradas e registros cumulativos (*append-only*), o saldo oficial é a soma direta de todos os movimentos históricos de entrada menos todos os movimentos históricos de saída. Movimentos compensatórios anulam seus movimentos originais pela álgebra de sinais opostos, sem necessidade de descarte condicional:

```typescript
function reconcileAccountBalance(movements: FinancialMovement[]): number {
  let balanceCents = 0;
  for (const mov of movements) {
    if (mov.direction === 'inflow') {
      balanceCents += mov.amountCents;
    } else if (mov.direction === 'outflow') {
      balanceCents -= mov.amountCents;
    }
  }
  return balanceCents;
}
```
*Propriedade Matemática de Anulação:*
Se um movimento original de entrada possui $+V$ e seu movimento compensatório possui $-V$, a soma acumulada resulta em $(+V) + (-V) = 0$, restabelecendo a exata posição financeira sem qualquer mutação de registros passados.

---

# 8. Modelo de Autorização, Privacidade e Isolamento de Dados

1. **Blindagem de Dados Bancários (`PrivatePaymentMetadata`):** Agência, conta corrente, chaves PIX e comprovantes fiscais ficam restritos ao titular (`request.auth.uid == userId`). Nenhum membro de espaço compartilhado tem permissão de leitura sobre a subcoleção privada de outro membro.
2. **Proteção de E-mails em Espaços:** Membros comuns visualizam apenas `displayName` e `uid`. O campo `contactEmail` é visível exclusivamente ao titular e administradores do espaço.
3. **Imutabilidade Pós-Arquivamento:** Espaços com `spaceStatus == 'archived'` têm todas as operações de escrita bloqueadas a nível de regras Firestore para despesas, itens, listas e pagamentos.

---

# 9. Regras Completas do Firestore (Cobertura Integral de Coleções)

A especificação abaixo contempla 100% das coleções e subcoleções da arquitetura v3.1:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Funções Utilitárias de Governança
    function isAuthenticated() {
      return request.auth != null;
    }

    function isOwner(userId) {
      return isAuthenticated() && request.auth.uid == userId;
    }

    function isSpaceActive(spaceId) {
      return get(/databases/$(database)/documents/spaces/$(spaceId)).data.spaceStatus == 'active';
    }

    function isSpaceMember(spaceId) {
      return isAuthenticated() && 
        request.auth.uid in get(/databases/$(database)/documents/spaces/$(spaceId)).data.memberUids;
    }

    function isSpaceCreator(spaceId) {
      return isAuthenticated() && 
        request.auth.uid == get(/databases/$(database)/documents/spaces/$(spaceId)).data.creatorUid;
    }

    // 1. Contas Pessoais e Livro de Movimentações
    match /accounts/{accountId} {
      allow read: if isAuthenticated() && resource.data.userId == request.auth.uid;
      allow create: if isAuthenticated() && request.resource.data.userId == request.auth.uid;
      allow update: if isAuthenticated() && resource.data.userId == request.auth.uid &&
        request.resource.data.userId == resource.data.userId; // userId é imutável
      allow delete: if false; // Contas com histórico contábil são arquivadas, nunca deletadas

      // 1.1 Livro Oficial de Movimentações
      match /movements/{movementId} {
        allow read: if isAuthenticated() && 
          get(/databases/$(database)/documents/accounts/$(accountId)).data.userId == request.auth.uid;
        allow create: if isAuthenticated() && 
          get(/databases/$(database)/documents/accounts/$(accountId)).data.userId == request.auth.uid &&
          request.resource.data.userId == request.auth.uid &&
          request.resource.data.amountCents > 0;
        allow update: if false; // Movimentos são estritamente imutáveis
        allow delete: if false; // Estornos criam novos movimentos compensatórios
      }

      // 1.2 Metadados Privados e Comprovantes
      match /private_payment_metadata/{paymentId} {
        allow read, write: if isAuthenticated() && 
          get(/databases/$(database)/documents/accounts/$(accountId)).data.userId == request.auth.uid;
      }

      // 1.3 Faturas de Cartão e Pagamentos
      match /invoices/{invoiceMonth} {
        allow read: if isAuthenticated() && 
          get(/databases/$(database)/documents/accounts/$(accountId)).data.userId == request.auth.uid;
        allow write: if isAuthenticated() && 
          get(/databases/$(database)/documents/accounts/$(accountId)).data.userId == request.auth.uid;

        match /payments/{paymentId} {
          allow read, write: if isAuthenticated() && 
            get(/databases/$(database)/documents/accounts/$(accountId)).data.userId == request.auth.uid;
        }

        match /carry_overs/{carryId} {
          allow read, write: if isAuthenticated() && 
            get(/databases/$(database)/documents/accounts/$(accountId)).data.userId == request.auth.uid;
        }
      }
    }

    // 2. Transações e Obrigações Pessoais do Usuário
    match /users/{userId}/personal_transactions/{txId} {
      allow read, write: if isOwner(userId);
    }

    match /users/{userId}/adhoc_obligations/{obligationId} {
      allow read: if isAuthenticated() && 
        (request.auth.uid == userId || request.auth.uid == resource.data.creditorUid);
      allow create: if isAuthenticated() && request.auth.uid == request.resource.data.creditorUid;
      allow update: if isAuthenticated() && (
        (request.auth.uid == userId && 
         request.resource.data.diff(resource.data).affectedKeys().hasOnly(['obligationStatus', 'paidAmountCents', 'guestRejectionReason'])) ||
        (request.auth.uid == resource.data.creditorUid && 
         request.resource.data.diff(resource.data).affectedKeys().hasOnly(['obligationStatus', 'paidAmountCents', 'remainingBalanceCents']))
      );
      allow delete: if false;
    }

    // 3. Rateios Avulsos (Despesas fora de espaço)
    match /adhoc_expenses/{expenseId} {
      allow read: if isAuthenticated() && (
        request.auth.uid == resource.data.ownerUid || 
        request.auth.uid in resource.data.registeredDebtorUids
      );
      allow create: if isAuthenticated() && request.auth.uid == request.resource.data.ownerUid;
      allow update: if isAuthenticated() && request.auth.uid == resource.data.ownerUid;
      allow delete: if false;

      // 3.1 Devedores Externos sem Conta (Exclusivo para rateio avulso)
      match /external_debtors/{debtorId} {
        allow read, write: if isAuthenticated() && 
          get(/databases/$(database)/documents/adhoc_expenses/$(expenseId)).data.ownerUid == request.auth.uid;

        match /receipt_events/{eventId} {
          allow read, write: if isAuthenticated() && 
            get(/databases/$(database)/documents/adhoc_expenses/$(expenseId)).data.ownerUid == request.auth.uid;
        }
      }

      // 3.2 Reembolsos de Usuários Cadastrados
      match /reimbursements/{reimbursementId} {
        allow read: if isAuthenticated() && (
          get(/databases/$(database)/documents/adhoc_expenses/$(expenseId)).data.ownerUid == request.auth.uid ||
          resource.data.debtorUid == request.auth.uid
        );
        allow create: if isAuthenticated() && request.resource.data.debtorUid == request.auth.uid;
        allow update: if isAuthenticated() && (
          // O credor valida a confirmação ou rejeição do reembolso
          request.auth.uid == get(/databases/$(database)/documents/adhoc_expenses/$(expenseId)).data.ownerUid &&
          request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status', 'destinationAccountId', 'financialMovementId', 'confirmedAt', 'rejectionReason'])
        );
      }
    }

    // 3.3 Tokens de Convite para Rateios Avulsos
    match /adhoc_invites/{tokenId} {
      allow read: if true; // Aberto para permitir validação antes da autenticação
      allow create: if isAuthenticated() && request.resource.data.creatorUid == request.auth.uid;
      allow update: if isAuthenticated() && 
        request.resource.data.diff(resource.data).affectedKeys().hasOnly(['tokenStatus', 'acceptedByUid', 'acceptedAt']);
    }

    // 4. Espaços Compartilhados e Governança
    match /spaces/{spaceId} {
      allow read: if isSpaceMember(spaceId);
      allow create: if isAuthenticated() && 
        request.resource.data.creatorUid == request.auth.uid &&
        request.resource.data.ownerId == request.auth.uid;
      allow update: if isSpaceMember(spaceId) && (
        // Somente o criador pode arquivar ou iniciar solicitação de dissolução
        (request.auth.uid == resource.data.creatorUid && 
         request.resource.data.diff(resource.data).affectedKeys().hasAny(['spaceStatus', 'archivedAt', 'archivedByUid'])) ||
        // Configurações gerais permitidas apenas se o espaço estiver ativo
        (isSpaceActive(spaceId) && request.auth.uid in resource.data.memberUids &&
         !request.resource.data.diff(resource.data).affectedKeys().hasAny(['creatorUid', 'ownerId', 'spaceStatus']))
      );
      allow delete: if false;

      // 4.1 Membros do Espaço
      match /members/{memberUid} {
        allow read: if isSpaceMember(spaceId);
        allow write: if isSpaceActive(spaceId) && (
          request.auth.uid == get(/databases/$(database)/documents/spaces/$(spaceId)).data.ownerId ||
          request.auth.uid == memberUid
        );
      }

      // 4.2 Solicitação de Dissolução e Destinação Individual
      match /dissolution/{docId} {
        allow read: if isSpaceMember(spaceId);
        allow create: if isSpaceCreator(spaceId) && 
          request.resource.data.initiatedByUid == request.auth.uid;
        allow update: if isSpaceMember(spaceId) && (
          // Cancelamento pelo criador
          (isSpaceCreator(spaceId) && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['requestStatus', 'cancelledAt', 'cancellationReason'])) ||
          // Resposta do autor para a sua própria destinação
          (request.auth.uid in get(/databases/$(database)/documents/spaces/$(spaceId)).data.memberUids &&
           request.resource.data.diff(resource.data).affectedKeys().hasOnly(['authorDestinations']))
        );
      }

      // 4.3 Despesas Compartilhadas (Travadas se o espaço estiver arquivado)
      match /shared_expenses/{expenseId} {
        allow read: if isSpaceMember(spaceId);
        allow create: if isSpaceMember(spaceId) && isSpaceActive(spaceId) &&
          request.resource.data.createdByUid == request.auth.uid;
        allow update: if isSpaceMember(spaceId) && isSpaceActive(spaceId) && (
          // Validação pelo responsável da despesa (credor primário)
          (request.auth.uid == resource.data.responsibleUid &&
           request.resource.data.diff(resource.data).affectedKeys().hasOnly(['validationStatus', 'validatedByUid', 'validatedAt', 'rejectionReason', 'commitmentStatus', 'paymentExecutionStatus'])) ||
          // Edição pelo autor antes de ser aprovada
          (request.auth.uid == resource.data.createdByUid && 
           resource.data.validationStatus in ['pending_validation', 'rejected'] &&
           request.resource.data.createdByUid == resource.data.createdByUid)
        );
        allow delete: if false;

        match /liabilities/{memberUid} {
          allow read: if isSpaceMember(spaceId);
          allow write: if isSpaceMember(spaceId) && isSpaceActive(spaceId);
        }

        match /payments/{paymentId} {
          allow read: if isSpaceMember(spaceId);
          allow create: if isSpaceMember(spaceId) && isSpaceActive(spaceId) &&
            request.resource.data.executedByUid == request.auth.uid;
          allow update: if isSpaceMember(spaceId) && isSpaceActive(spaceId) &&
            request.auth.uid == get(/databases/$(database)/documents/spaces/$(spaceId)/shared_expenses/$(expenseId)).data.responsibleUid;
        }

        match /bilateral_debts/{debtId} {
          allow read: if isSpaceMember(spaceId);
          allow write: if isSpaceMember(spaceId) && isSpaceActive(spaceId);
        }

        match /refunds/{refundId} {
          allow read: if isSpaceMember(spaceId);
          allow write: if isSpaceMember(spaceId) && isSpaceActive(spaceId) &&
            request.auth.uid == get(/databases/$(database)/documents/spaces/$(spaceId)/shared_expenses/$(expenseId)).data.responsibleUid;
        }
      }

      // 4.4 Liquidações Bilaterais de Dívidas
      match /settlements/{settlementId} {
        allow read: if isSpaceMember(spaceId);
        allow create: if isSpaceMember(spaceId) && isSpaceActive(spaceId) &&
          request.resource.data.debtorUid == request.auth.uid;
        allow update: if isSpaceMember(spaceId) && isSpaceActive(spaceId) && (
          // Validação exclusiva pelo credor que recebe os fundos
          request.auth.uid == resource.data.creditorUid &&
          request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status', 'confirmedAt', 'confirmedByUid', 'destinationAccountId', 'financialMovementInflowId'])
        );

        match /allocations/{allocationId} {
          allow read: if isSpaceMember(spaceId);
          allow write: if isSpaceMember(spaceId) && isSpaceActive(spaceId);
        }

        match /reversions/{reversionId} {
          allow read: if isSpaceMember(spaceId);
          allow write: if isSpaceMember(spaceId) && isSpaceActive(spaceId) &&
            request.auth.uid == get(/databases/$(database)/documents/spaces/$(spaceId)/settlements/$(settlementId)).data.creditorUid;
        }
      }
    }

    // 5. Transferências sob Custódia (Bilateral e Espaços)
    match /transfers/{transferId} {
      allow read: if isAuthenticated() && (
        resource.data.senderUid == request.auth.uid || 
        resource.data.custodianUid == request.auth.uid ||
        (resource.data.spaceId != null && isSpaceMember(resource.data.spaceId))
      );
      allow create: if isAuthenticated() && request.resource.data.senderUid == request.auth.uid;
      allow update: if isAuthenticated() && (
        // Confirmação de recebimento pelo custodiante
        (request.auth.uid == resource.data.custodianUid &&
         request.resource.data.diff(resource.data).affectedKeys().hasOnly(['custodyStatus', 'destinationAccountId', 'availableBalanceCents', 'updatedAt'])) ||
        // Abatimento em despesa pelo custodiante
        (request.auth.uid == resource.data.custodianUid &&
         request.resource.data.diff(resource.data).affectedKeys().hasOnly(['usedAmountCents', 'availableBalanceCents', 'custodyStatus', 'updatedAt'])) ||
        // Confirmação de devolução pelo remetente original
        (request.auth.uid == resource.data.senderUid &&
         request.resource.data.diff(resource.data).affectedKeys().hasOnly(['returnedAmountCents', 'availableBalanceCents', 'custodyStatus', 'updatedAt']))
      );

      match /events/{eventId} {
        allow read: if isAuthenticated() && (
          get(/databases/$(database)/documents/transfers/$(transferId)).data.senderUid == request.auth.uid ||
          get(/databases/$(database)/documents/transfers/$(transferId)).data.custodianUid == request.auth.uid
        );
        allow create: if isAuthenticated() && (
          request.auth.uid == get(/databases/$(database)/documents/transfers/$(transferId)).data.senderUid ||
          request.auth.uid == get(/databases/$(database)/documents/transfers/$(transferId)).data.custodianUid
        );
        allow update, delete: if false; // Eventos são estritamente imutáveis
      }
    }

    // 6. Listas de Aquisição e Copropriedade
    match /acquisition_lists/{listId} {
      allow read: if isAuthenticated() && (
        (resource.data.scopeType == 'individual' && resource.data.ownerUid == request.auth.uid) ||
        (resource.data.scopeType == 'shared' && isSpaceMember(resource.data.spaceId))
      );
      allow create: if isAuthenticated() && (
        (request.resource.data.scopeType == 'individual' && request.resource.data.ownerUid == request.auth.uid) ||
        (request.resource.data.scopeType == 'shared' && isSpaceMember(request.resource.data.spaceId) && isSpaceActive(request.resource.data.spaceId))
      );
      allow update: if isAuthenticated() && (
        (resource.data.scopeType == 'individual' && resource.data.ownerUid == request.auth.uid) ||
        (resource.data.scopeType == 'shared' && isSpaceMember(resource.data.spaceId) && isSpaceActive(resource.data.spaceId))
      );
      allow delete: if false;

      match /items/{itemId} {
        allow read: if isAuthenticated();
        allow write: if isAuthenticated();

        match /purchases/{purchaseId} {
          allow read: if isAuthenticated();
          allow create: if isAuthenticated() && request.resource.data.authorUid == request.auth.uid;
          allow update, delete: if false; // Compras efetivadas e percentuais de copropriedade são imutáveis
        }

        match /quotes/{quoteId} {
          allow read, write: if isAuthenticated();
        }

        match /deposits/{depositId} {
          allow read: if isAuthenticated();
          allow create: if isAuthenticated() && request.resource.data.contributorUid == request.auth.uid;
        }

        match /stock_movements/{movementId} {
          allow read: if isAuthenticated();
          allow create: if isAuthenticated() && request.resource.data.authorUid == request.auth.uid;
        }
      }
    }

    // 7. Recorrências e Parcelamentos
    match /recurrence_rules/{ruleId} {
      allow read, write: if isAuthenticated() && resource.data.userId == request.auth.uid;
      match /instances/{competenceMonth} {
        allow read, write: if isAuthenticated();
      }
    }

    match /installment_contracts/{contractId} {
      allow read, write: if isAuthenticated() && resource.data.userId == request.auth.uid;
      match /occurrences/{installmentNumber} {
        allow read, write: if isAuthenticated();
      }
    }
  }
}
```

---

# 10. Exemplos Práticos de Fluxos Financeiros Ponta a Ponta

### 10.1. Rateio Avulso com Pessoa sem Cadastro Apenas por Nome
*Cenário:* Keniel paga uma conta de restaurante de R$ 300 no cartão e aponta que Carlos (sem app e sem e-mail) deve reembolsar R$ 100.
1. **Cadastro da Despesa:** Keniel cria `AdhocSplitExpense` (R$ 300 total, cota própria R$ 200, a reembolsar R$ 100).
2. **Devedor Externo:** Cria `ExternalDebtorRecord` com `name: "Carlos"`, `identificationType: 'name_only'`, `assignedAmountCents: 10000`.
3. **Recebimento Parcial em Espécie:** Dias depois, Carlos entrega R$ 40 em dinheiro vivo para Keniel.
4. **Baixa Manual:** Keniel clica em "Registrar Recebimento Manual":
   - Informa: R$ 40,00, Data de hoje, Destino: "Carteira Dinheiro".
   - Grava `AdhocReceiptEvent` com R$ 40,00.
   - Emite atomicamente `FinancialMovement` na conta "Carteira Dinheiro" (`direction: 'inflow'`, `amountCents: 4000`, `originType: 'adhoc_receipt'`).
   - O saldo de Carlos atualiza para `remainingBalanceCents: 6000` (`partially_cleared`).
5. **Quitação Final via PIX:** Carlos transfere os R$ 60 restantes via PIX no Nubank de Keniel. Keniel dá a segunda baixa manual, gerando novo `FinancialMovement` de entrada no Nubank. O status de Carlos passa para `cleared`. A fatura do cartão permanece nos R$ 300 originais, preservando integridade com a operadora.

### 10.2. Transferência sob Custódia com Consumo e Devolução
*Cenário:* Mariana envia R$ 600 do Itaú para a conta de Keniel para custear gastos de reforma do apartamento compartilhado.
1. **Envio Declarado:** Mariana cria `CustodyTransfer` com saída de sua conta Itaú. Emite `FinancialMovement` de saída (`outflow`) no Itaú de Mariana. Status `pending_receipt`.
2. **Confirmação de Recebimento:** Keniel seleciona sua conta Nubank e clica em "Confirmar Recebimento". Emite `FinancialMovement` de entrada (`inflow`, `custody_deposit`) no Nubank de Keniel sob passivo de custódia. Status passa para `available`.
3. **Consumo em Despesa (R$ 450):** Keniel compra tintas por R$ 450 e cria `ExpensePayment` com `fundingSource: 'custody_transfer'`.
   - Gera `FinancialMovement` de débito real perante o fornecedor no Nubank de Keniel.
   - Abate o saldo de custódia de Mariana: `usedAmountCents: 45000`, `availableBalanceCents: 15000`.
   - Status passa para `partially_used`.
4. **Devolução do Saldo Remanescente (R$ 150):** A reforma acaba e Keniel devolve os R$ 150 via PIX para Mariana.
   - Keniel registra a saída no Nubank (`return_requested` / `partial_return_sent`), emitindo `FinancialMovement` de saída.
   - Mariana confere o extrato no Itaú e clica em "Confirmar Recebimento da Devolução".
   - Emite `FinancialMovement` de entrada no Itaú de Mariana.
   - O saldo da custódia fecha em R$ 0,00 e o status é consolidado como `settled_by_mixed`.

---

# 11. Idempotência, Concorrência e Auditoria

1. **Chaves de Idempotência Determinísticas:**
   Todas as movimentações e checkouts utilizam chaves com composição canônica:
   - Pagamento de despesa: `${expenseId}_${funderUid}_${paymentDate}_${amountCents}`
   - Recebimento avulso: `${adhocExpenseId}_${debtorId}_${receiptDate}_${amountCents}`
   - Movimentação bancária: `mov_${originType}_${originId}_${direction}`
2. **Transações Firestore (`runTransaction`):**
   Operações que envolvem atualização de saldos projetados e gravação no Livro de Movimentações são executadas estritamente em transações atômicas ACID, garantindo que o saldo projetado seja lido, incrementado/decrementado e o movimento gravado sob o mesmo isolamento transacional.
3. **Concorrência Otimista em Compras:**
   A subcoleção `AcquisitionPurchaseRecord` valida se o item de compra não foi conferido concorrentemente por outro participante. Caso haja colisão, a segunda transação é abortada com notificação explicativa.

---

# 12. Tratamento de Erros, Cancelamentos e Reversões

1. **Reversão de Liquidação Bilateral (`SettlementReversionEvent`):**
   Caso uma liquidação entre membros seja contestada, a reversão contábil **não exclui** o registro nem finge desfazer uma transferência bancária externa. Ela cria um evento de estorno e emite movimentações compensatórias inversas no Livro de Movimentações das contas envolvidas.
2. **Estorno de Fornecedor Comercial (`SupplierRefundEvent`):**
   Quando uma compra é devolvida ou cancelada pela loja:
   - Se devolução integral: a despesa passa para `closed` e um crédito de recomposição de caixa é emitido na conta do participante que recebeu o dinheiro da loja.
   - Se perda irrecuperável (ex: calote de fornecedor): a despesa passa para `loss_unrecoverable` e as cotas dos participantes são recalculadas proporcionalmente ao prejuízo absorvido.

---

# 13. Relação das Decisões de Negócio Aprovadas

- **A1:** 100% das operações de participantes comuns dependem de validação do responsável/credor.
- **A2:** A fonte oficial de saldos é o **Histórico de Movimentações Financeiras** (`FinancialMovement`).
- **A3:** Eliminação total de fundos de reserva ou caixas coletivos em favor de contratos de custódia pessoal.
- **A4:** Autoridade exclusiva do **Criador do Espaço (`creatorUid`)** para solicitar a exclusão definitiva.
- **A5:** Prazo improrrogável de **30 dias** para resposta de autores na solicitação de exclusão, com cancelamento automático por silêncio/ausência de resposta e manutenção do estado arquivado seguro.
- **A6:** Rateios avulsos suportam devedores externos identificados apenas por nome com baixa manual pelo credor.
- **A7:** Copropriedade de aquisições calculada na compra efetiva com base em desembolsos reais.
- **A8:** Reembolsos avulsos não abatem faturas de cartão de crédito.
- **A9:** Transição para banco de dados limpo (*greenfield*).

---

# 14. Relação das Decisões de Negócio Pendentes

Nesta versão 3.1, **todas as decisões conceituais de negócio foram formalizadas e harmonizadas**. Não restam inconsistências entre entidades.

Apenas **1 aspecto de política operacional** aguarda homologação:
- **Janela de Reabertura de Notificações de Dissolução:** Quando uma solicitação de exclusão de espaço for automaticamente cancelada aos 30 dias por falta de resposta de um membro, deve haver um intervalo mínimo de carência (ex: 7 ou 15 dias) antes que o criador possa disparar uma nova solicitação, a fim de evitar sobrecarga de notificações aos demais membros?
  - *Alternativa 1 (Recomendada):* Carência de 7 dias antes de permitir nova solicitação.
  - *Alternativa 2:* Sem carência, permitindo ao criador reiniciar imediatamente após contato prévio com o membro pendente.

---

# 15. Matriz de Rastreabilidade de Requisitos

| Requisito do Domínio | Entidades e Subcoleções no Firestore | Mecanismo de Garantia e Regras |
| :--- | :--- | :--- |
| **Fonte Oficial da Verdade dos Saldos** | `accounts/{accountId}/movements/{movementId}` (`FinancialMovement`) | Saldo projetado derivado da soma dos movimentos; nenhum saldo é alterado sem movimento auditável. |
| **Exclusão Definitiva sem Quebra de Consentimento** | `spaces/{spaceId}/dissolution/request` (`SpaceDissolutionRequest`) | Prazo de 30 dias; cancelamento automático se qualquer autor ficar em `pending`; preservação total em `archived`. |
| **Pessoas Externas em Rateios Avulsos** | `adhoc_expenses/{id}/external_debtors/` e `receipt_events/` | Baixa manual pelo credor; geração imediata de movimento de entrada na conta do credor; sem confirmação fictícia. |
| **Convites Seguros por E-mail** | `adhoc_invites/{tokenId}` (`AdhocInviteToken`) | Token com hash SHA-256; uso único; prazo de 15 dias; vinculação posterior atômica ao UID cadastrado. |
| **Rastreabilidade Bancária de Custódia** | `transfers/{transferId}` e `transfers/{id}/events/` | 11 estados explícitos; geração de movimento financeiro na saída, entrada, consumo e devolução confirmada. |
| **Copropriedade Proporcional de Bens** | `acquisition_lists/{id}/items/{id}/purchases/{purchaseId}` | Desembolsos reais gravados por compra; cálculo percentual exato; preservação histórica em itens recorrentes. |
| **Desacoplamento de Recorrências e Parcelas** | `recurrence_rules/`, `instances/`, `contracts/`, `occurrences/` | Alteração de regras afeta apenas competências futuras; competências passadas permanecem imutáveis. |
| **Segurança e Isolamento Físico de Metadados** | `accounts/{id}/private_payment_metadata/` | Subcoleção restrita ao titular via regras Firestore; blindagem contra vazamento de agência/conta para o grupo. |
| **Imutabilidade Operacional de Espaços Arquivados** | `spaces/{spaceId}` (`spaceStatus == 'archived'`) | Regras de segurança bloqueiam qualquer escrita em subcoleções caso o espaço não esteja `active`. |

---
*Fim da Especificação da Arquitetura de Dados v3.1. Documento normativo concluído sem qualquer alteração no código-fonte do projeto.*
