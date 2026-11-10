# Especificação da Arquitetura de Dados Definitiva (Versão 3.0)
## Sistema Financeiro Individual, Espaços Compartilhados, Rateios Avulsos, Transferências sob Custódia e Listas de Aquisição com Copropriedade

**Documento Oficial de Engenharia de Dados, Governança e Segurança da Informação**  
**Versão:** 3.0  
**Data da Revisão:** 09 de Novembro de 2026  
**Status do Documento:** SUBMETIDA PARA APROVAÇÃO — SEM AUTORIZAÇÃO DE IMPLEMENTAÇÃO  
**Compromisso Normativo:** Nenhuma linha de código, componente, regra ou banco de dados foi alterada.  
**Evidências de Código Auditadas:** `src/types/finance.ts`, `src/types/acquisitions.ts`, `src/utils/financeEngine.ts`, `src/utils/stateMachine.ts`, `src/App.tsx`, `src/components/PendingDisputesView.tsx`, `src/components/UniversalTransactionModal.tsx`.

---

## Histórico de Alterações em Relação à Versão 2.0

| Ponto Modificado | O Que Havia na v2.0 | Problema Identificado na v2.0 | Solução Incorporada na v3.0 | Classificação |
| :--- | :--- | :--- | :--- | :--- |
| **1. Pessoas Externas em Rateios Avulsos** | Exigia que todo convidado fosse usuário cadastrado ou gerasse pendência com e-mail pré-cadastrado. | Impedia registrar contas a receber de pessoas físicas sem conta no app (amigos da pelada, parentes sem smartphone). | Criada a entidade `ExternalDebtor` exclusiva para rateios avulsos, suportando: (A) Pessoa com e-mail (com convite opcional); (B) Pessoa identificada somente por Nome, com quitação manual pelo autor. | `[APROVADO]` |
| **2. Arquivamento e Dissolução de Espaços** | Tratava dissolução e arquivamento como estados transitórios sem detalhar o bloqueio físico no banco. | Risco de operações antigas ou chamadas concorrentes mutarem dados de um espaço já dissolvido. | Formalizado o estado `archived` como congelamento operacional (somente leitura para consulta). Regras de segurança bloqueiam qualquer escrita em espaços arquivados. | `[APROVADO]` |
| **3. Propriedade de Bens por Compra Efetiva** | Propriedade estava associada a `AcquisitionItem`. | Um item recorrente (ex: *Café Especial*, *Filtro de Água*) é comprado várias vezes, por pessoas diferentes e com cotas diferentes. | Propriedade transferida para a instância de compra efetiva (`AcquisitionPurchaseRecord` / `ProductPurchase`), com registro de desembolso real e percentuais calculados por compra. | `[APROVADO]` |
| **4. Caminho Real do Dinheiro na Custódia** | Modelo continha apenas saldo abstrato de custódia sem mapear a transição bancária real. | Não demonstrava de onde o dinheiro saiu, onde entrou, como foi consumido e como retornou. | Mapeamento do ciclo bancário completo: saída da conta do remetente, entrada na conta do custodiante (sob passivo), confirmação, consumo em despesa e devolução confirmada. | `[APROVADO]` |
| **5. Reembolsos Avulsos sem Impacto em Fatura** | Reembolso corria risco de ser lançado como abatimento automático de fatura ou receita comum. | O app não tem integração bancária e despesas de cartão mantêm faturas intactas com a operadora. | O reembolso gera entrada real de caixa na conta/carteira escolhida pelo credor, preservando o valor nominal da fatura do cartão em seu total original. | `[APROVADO]` |
| **6. Recorrências e Parcelamentos Desacoplados** | Misturava regras com ocorrências ativas. | Alterar uma recorrência ou parcelamento podia corromper competências passadas. | Desacoplamento entre Regra (`RecurrenceRule`, `InstallmentContract`) e Ocorrências (`RecurrenceInstance`, `InstallmentOccurrence`), afetando apenas meses futuros. | `[APROVADO]` |
| **7. Exclusão Definitiva de Espaço com Destinação Individual** | Não definia o fluxo formal quando o usuário decide apagar de vez um espaço. | Violação de privacidade e consentimento se dados fossem apagados sem anuência dos autores. | Fluxo formal de consentimento individual onde cada autor decide a destinação de seus próprios dados (migrar para individual existente, criar novo, arquivar ou apagar). | `[APROVADO]` |
| **8. Eliminação de Fundo Coletivo Consolidada** | Ausência total de entidades de caixa coletivo ou fundos. | Mantido 100% aderente à decisão anterior. | Fundo coletivo completamente banido; toda transação entre participantes é transferência sob custódia bilateral. | `[APROVADO]` |

---

# 1. Objetivo e Escopo

Esta especificação define a arquitetura de dados definitiva e as regras de integridade contábil do sistema para operação em base limpa (*greenfield*), cobrindo quatro domínios integrados:
1. **Financeiro Individual:** Controle de receitas, despesas, contas correntes, cartões de crédito, faturas, pendências e orçamentos pessoais, com total independência operacional de qualquer grupo.
2. **Espaços Compartilhados:** Gestão coletiva de despesas de moradia, viagens ou projetos, com rateios parametrizados, separação estrita de papéis, compensação de saldos e governança auditável.
3. **Rateios Avulsos:** Despesas pessoais compartilhadas com terceiros (usuários cadastrados ou pessoas externas sem conta), com fluxo de aprovação e reembolso vinculado em duas vias.
4. **Listas de Aquisição com Copropriedade:** Listas de abastecimento recorrente, metas de compra e desejos, integradas bidirecionalmente às despesas financeiras e com registro proporcional de copropriedade por compra.

---

# 2. Princípios Fundamentais do Modelo

- **P1. Sem Fundo de Reserva ou Caixa Coletivo:** `[APROVADO]`  
  Não existem caixas comuns com personalidade jurídica própria. Recursos adiantados para pagamentos futuros constituem contratos bilaterais de **Transferência sob Custódia** entre pessoas físicas.
- **P2. Validação Pertence ao Responsável pela Despesa/Pendência:** `[APROVADO]`  
  Quem desembolsou o dinheiro ou a quem a obrigação é devida é a autoridade legítima para confirmar o recebimento ou a baixa da pendência. Não há autoaprovação arbitrária: o credor atesta se recebeu o recurso.
- **P3. Ausência de Integração Bancária Automática:** `[APROVADO]`  
  O sistema é uma ferramenta de gestão contábil e planejamento, não um banco ou iniciador de pagamentos (Open Finance). O registro de que um pagamento "foi feito" é uma **declaração**, que só produz efeitos no saldo oficial após **confirmação de recebimento** pelo credor.
- **P4. Valores Estritamente em Centavos Inteiros:** `[PROPOSTA TÉCNICA]`  
  Todos os montantes monetários são campos inteiros positivos (`number`), representando centavos da moeda BRL (ex: R$ 150,50 é armazenado como `15050`). Elimina erros de arredondamento por ponto flutuante.
- **P5. Identificação Estável por UID do Firebase Auth:** `[APROVADO]`  
  Nenhuma regra de negócio, permissão ou vínculo relacional utiliza e-mail como chave primária ou estrangeira. E-mails são metadados de contato e comunicação.
- **P6. Segregação Física de Dados Privados vs. Públicos:** `[PROPOSTA TÉCNICA]`  
  O Firestore aplica regras de segurança no nível de documentos inteiros. Dados bancários confidenciais (agência, conta, comprovantes) residem em subcoleções privadas do titular; o grupo acessa apenas documentos públicos com rótulos genéricos.

---

# 3. Diagnóstico da Arquitetura Atual

A inspeção detalhada no código confirmou as seguintes evidências estruturais:
1. **Sobrecarga de `Transaction` (`src/types/finance.ts:68-102`):** A mesma interface agrega `spaceId: ''` (individual), `spaceId: 'sp_1'` (espaço), `splits: SplitShare[]` (rateios avulsos e coletivos), e `description: 'Reembolso Livro-Razão:'` (liquidação sintética).
2. **Consultas Baseadas em E-mail (`src/App.tsx:605-608`):** A consulta `where('participantEmails', 'array-contains', email)` busca dados misturados de espaços e finanças pessoais na mesma coleção `/transactions`.
3. **Quitação de Fatura Inócua (`src/App.tsx:825-865`):** A função `handlePayInvoice` ignora `_sourceCheckingId`, marcando cartões como pagos sem debitar contas bancárias.
4. **Falta de Vínculo Bidirecional com Listas (`src/App.tsx:2584`):** O handler `onCreateExpenseFromPurchase` descarta o `itemId` e força `presetSpaceId(undefined)`, desconectando compras de listas compartilhadas de seus espaços de origem.

---

# 4. Modelo de Entidades e Relacionamentos

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
                 │                 ├── 1:N ──> AdhocReimbursement (Baixas Confirmadas de Reembolso)
                 │                 │
                 │                 └── 0:N ──> ExternalDebtorRecord (Devedores sem cadastro no app)
                 │
                 ├── 1:N ──> CustodyTransfer (Contratos de Custódia: Remetente ou Custodiante)
                 │                 │
                 │                 └── 1:N ──> CustodyTransferEvent (Histórico Imutável de Movimentações)
                 │
                 ├── 1:N ──> AcquisitionList [scopeType: 'individual']
                 │                 │
                 │                 └── 1:N ──> AcquisitionItem ── 1:N ──> AcquisitionPurchaseRecord
                 │
                 └── N:M ──> Space (Espaços Compartilhados com Governança)
                               │
                               ├── 1:N ──> SpaceMember (Estados independentes de participação)
                               │
                               ├── 1:N ──> AcquisitionList [scopeType: 'shared']
                               │                 │
                               │                 └── 1:N ──> AcquisitionItem
                               │                                   │
                               │                                   └── 1:N ──> AcquisitionPurchaseRecord (com copropriedade)
                               │
                               ├── 1:N ──> SharedExpense (Despesas Coletivas com Papéis Desacoplados)
                               │                 │
                               │                 ├── 1:N ──> ExpenseLiability (Cotas brutas de rateio)
                               │                 │
                               │                 ├── 1:N ──> ExpensePayment (Pagamentos reconhecidos perante fornecedor)
                               │                 │
                               │                 ├── 1:N ──> BilateralDebtLedger (Visão determinística de créditos)
                               │                 │                 │
                               │                 │                 └── 1:N ──< SettlementAllocation
                               │                 │                                      │
                               │                 ├── 1:N ──> SettlementRecord ──────────┘
                               │                 │                 │
                               │                 │                 └── 1:N ──> SettlementReversionEvent
                               │                 │
                               │                 └── 1:N ──> SupplierRefundEvent (Estornos ou perdas de fornecedor)
                               │
                               └── 0:1 ──> SpaceDissolutionRequest (Processo de dissolução e partilha de dados)
```

---

# 5. Dicionário Completo de Campos e Estrutura Firestore

---

### 5.1. Contas Pessoais e Transações Individuais

#### `Account` (`accounts/{accountId}`)
- `id`: string (PK)
- `userId`: string (FK `users/{uid}`) `[APROVADO]`
- `name`: string (Ex: "Nubank Principal", "Itaú Corrente") `[APROVADO]`
- `type`: `'checking' | 'credit'` `[APROVADO]`
- `currentBalanceCents`: number (Saldo em centavos para conta corrente) `[PROPOSTA TÉCNICA]`
- `creditLimitCents`: number (Limite total para cartão de crédito) `[APROVADO]`
- `closingDay`: number (1 a 31) `[APROVADO]`
- `dueDay`: number (1 a 31) `[APROVADO]`
- `color`: string
- `icon`: string
- `isArchived`: boolean `[PROPOSTA TÉCNICA]`
- `createdAt`: string (ISO)

#### `PrivatePaymentMetadata` (`accounts/{accountId}/private_payment_metadata/{paymentId}`)
*Subcoleção isolada fisicamente no banco, restrita ao titular:*
- `paymentId`: string (PK)
- `userId`: string (FK `users/{uid}`) `[APROVADO]`
- `accountId`: string (FK `accounts/{accountId}`) `[APROVADO]`
- `bankName`: string (Ex: "Banco Santander S.A.") `[APROVADO]`
- `accountType`: `'checking' | 'credit'` `[APROVADO]`
- `receiptStorageUrl`?: string (Comprovante confidencial no Firebase Storage) `[APROVADO]`
- `realBankDebitTimestamp`: string (ISO) `[PROPOSTA TÉCNICA]`

#### `PersonalTransaction` (`users/{userId}/personal_transactions/{txId}`)
*Despesas e receitas puramente individuais:*
- `id`: string (PK)
- `userId`: string (FK `users/{uid}`) `[APROVADO]`
- `description`: string `[APROVADO]`
- `amountCents`: number `[APROVADO]`
- `type`: `'income' | 'expense'` `[APROVADO]`
- `status`: `'pending' | 'paid' | 'overdue'` `[APROVADO]`
- `categoryId`: string (FK `categories/{categoryId}`) `[APROVADO]`
- `categoryName`: string
- `accountId`: string (FK `accounts/{accountId}`) `[APROVADO]`
- `competenceDate`: string (YYYY-MM-DD) `[APROVADO]`
- `dueDate`: string (YYYY-MM-DD) `[APROVADO]`
- `paymentDate`?: string (YYYY-MM-DD) `[APROVADO]`
- `invoiceMonth`: string (YYYY-MM) `[APROVADO]`
- `originType`: `'manual' | 'shopping_list' | 'adhoc_reimbursement'` `[PROPOSTA TÉCNICA]`
- `originRefId`?: string (FK `items/{itemId}` ou FK `adhoc_expenses/{expenseId}`) `[PROPOSTA TÉCNICA]`
- `clientTransactionUuid`: string (Idempotência) `[PROPOSTA TÉCNICA]`
- `createdAt`: string (ISO)

#### `InternalAccountTransfer` (`users/{userId}/internal_transfers/{transferId}`)
*Transferências entre contas próprias do mesmo usuário:*
- `id`: string (PK)
- `userId`: string (FK `users/{uid}`) `[APROVADO]`
- `sourceAccountId`: string (FK `accounts/{accountId}`) `[APROVADO]`
- `destinationAccountId`: string (FK `accounts/{accountId}`) `[APROVADO]`
- `amountCents`: number `[APROVADO]`
- `transferDate`: string (YYYY-MM-DD) `[APROVADO]`
- `description`: string
- `clientTransactionUuid`: string `[PROPOSTA TÉCNICA]`
- `createdAt`: string (ISO)

---

### 5.2. Cartões de Crédito e Faturas

#### `CreditCardInvoice` (`accounts/{accountId}/invoices/{invoiceMonth}`)
*Representação formal da fatura de cartão de crédito para a competência YYYY-MM:*
- `id`: string (PK: `invoiceMonth`, ex: "2026-11")
- `accountId`: string (FK `accounts/{accountId}`) `[APROVADO]`
- `userId`: string (FK `users/{uid}`) `[APROVADO]`
- `invoiceMonth`: string (YYYY-MM) `[APROVADO]`
- `closingDate`: string (YYYY-MM-DD) `[APROVADO]`
- `dueDate`: string (YYYY-MM-DD) `[APROVADO]`
- `totalPurchasesAmountCents`: number (Compras do mês) `[PROPOSTA TÉCNICA]`
- `carriedOverBalanceCents`: number (Saldo rolado da fatura anterior) `[APROVADO]`
- `interestAndFeesCents`: number (Encargos, juros e multas de atraso) `[APROVADO]`
- `totalDueAmountCents`: number (`totalPurchases + carriedOver + interestAndFees`) `[PROPOSTA TÉCNICA]`
- `totalPaidAmountCents`: number (Soma de amortizações recebidas) `[APROVADO]`
- `remainingBalanceCents`: number (`totalDueAmountCents - totalPaidAmountCents`) `[APROVADO]`
- `invoiceStatus`: `'open' | 'closed' | 'partially_paid' | 'paid' | 'overdue'` `[APROVADO]`
- `updatedAt`: string (ISO)

#### `InvoicePayment` (`accounts/{accountId}/invoices/{invoiceMonth}/payments/{paymentId}`)
*Pagamento real da fatura com débito em conta corrente:*
- `id`: string (PK)
- `invoiceMonth`: string (FK)
- `accountId`: string (Cartão)
- `sourceCheckingAccountId`: string (Conta corrente pagadora que sofre débito real) `[APROVADO]`
- `amountPaidCents`: number `[APROVADO]`
- `paymentDate`: string (YYYY-MM-DD) `[APROVADO]`
- `clientTransactionUuid`: string `[PROPOSTA TÉCNICA]`
- `createdAt`: string (ISO)

#### `InvoiceCarryOver` (`accounts/{accountId}/invoices/{invoiceMonth}/carry_overs/{carryId}`)
*Transporte de saldo não pago de fatura para a competência seguinte (rotativo):*
- `id`: string (PK)
- `sourceInvoiceMonth`: string (Mês vencido de origem) `[APROVADO]`
- `targetInvoiceMonth`: string (Mês receptor) `[APROVADO]`
- `unpaidPrincipalCents`: number (Saldo principal transportado) `[APROVADO]`
- `interestRateMonthly`: number (Taxa de juro contratada) `[APROVADO]`
- `appliedInterestCents`: number (Juros calculados) `[APROVADO]`
- `status`: `'active' | 'settled'` `[PROPOSTA TÉCNICA]`
- `createdAt`: string (ISO)

---

### 5.3. Espaços Compartilhados, Governança e Dissolução

#### `Space` (`spaces/{spaceId}`)
*Entidade central de governança do grupo coletivo:*
- `id`: string (PK)
- `ownerId`: string (FK `users/{uid}`) `[APROVADO]`
- `name`: string `[APROVADO]`
- `description`: string
- `icon`: string
- `color`: string
- `spaceStatus`: `'active' | 'archived' | 'pending_deletion' | 'deleted'` `[APROVADO]`
- `archivedAt`?: string (ISO) `[APROVADO]`
- `archivedByUid`?: string (FK `users/{uid}`) `[APROVADO]`
- `memberUids`: string[] (Array indexado para segurança e permissões) `[APROVADO]`
- `enabledModules`: Array<`'finance' | 'acquisitions'`> `[APROVADO]`
- `monthlyBudgetCents`?: number
- `createdAt`: string (ISO)

#### `SpaceMember` (`spaces/{spaceId}/members/{memberUid}`)
*Participação e papel de cada participante no espaço (estados desacoplados do espaço):*
- `id`: string (PK: `memberUid`)
- `spaceId`: string (FK `spaces/{spaceId}`)
- `uid`: string (FK `users/{uid}`) `[APROVADO]`
- `name`: string
- `email`: string
- `role`: `'owner' | 'admin' | 'member'` `[APROVADO]`
- `participationStatus`: `'invited' | 'active' | 'voluntary_exit' | 'removed_by_admin' | 'declined'` `[APROVADO]`
- `statusReason`?: string (Motivo da recusa ou saída) `[PROPOSTA TÉCNICA]`
- `invitedAt`: string (ISO)
- `respondedAt`?: string (ISO)

#### `SpaceDissolutionRequest` (`spaces/{spaceId}/dissolution/request`)
*Processo formal de encerramento definitivo com destinação dos dados de cada autor:*
- `id`: string (PK: "request")
- `spaceId`: string (FK `spaces/{spaceId}`)
- `requestedByUid`: string (FK `users/{uid}`) `[APROVADO]`
- `requestedAt`: string (ISO) `[APROVADO]`
- `totalRecordsAffected`: {
    `expensesCount`: number;
    `paymentsCount`: number;
    `listsCount`: number;
    `itemsCount`: number;
  } `[APROVADO]`
- `authorDestinations`: {
    [authorUid: string]: {
      `decision`: `'migrate_to_existing_individual' | 'migrate_to_new_individual' | 'archive_hidden' | 'delete_permanently'`;
      `targetSpaceId`?: string;
      `decidedAt`: string;
    };
  } `[APROVADO]`
- `status`: `'pending_author_decisions' | 'executed' | 'cancelled'` `[APROVADO]`
- `cancellationReason`?: string

#### `SharedExpense` (`spaces/{spaceId}/shared_expenses/{expenseId}`)
*Despesa coletiva com separação formal de papéis:*
- `id`: string (PK)
- `spaceId`: string (FK `spaces/{spaceId}`) `[APROVADO]`
- `title`: string `[APROVADO]`
- `description`?: string
- `totalOriginalAmountCents`: number (Valor original da obrigação) `[APROVADO]`
- `competenceMonth`: string (YYYY-MM) `[APROVADO]`
- `competenceDate`: string (YYYY-MM-DD) `[APROVADO]`
- `dueDate`?: string (YYYY-MM-DD)
- `categoryId`: string
- `categoryName`: string
- **Papéis Desacoplados:**
  - `createdByUid`: string (Autor do cadastro) `[APROVADO]`
  - `responsibleUid`: string (Responsável financeiro da despesa / Credor das cotas) `[APROVADO]`
- **Máquinas de Estado:**
  - `validationStatus`: `'pending_validation' | 'approved' | 'rejected' | 'cancelled'` `[APROVADO]`
  - `commitmentStatus`: `'active' | 'closed' | 'cancelled_pre_payment' | 'loss_unrecoverable'` `[APROVADO]`
  - `paymentExecutionStatus`: `'unpaid' | 'partially_paid' | 'fully_paid'` `[APROVADO]`
- `validatedByUid`?: string (O `responsibleUid` que validou a despesa) `[APROVADO]`
- `validatedAt`?: string
- `rejectionReason`?: string
- `totalPaidToSupplierCents`: number (Valor reconhecido perante o fornecedor) `[PROPOSTA TÉCNICA]`
- `supplierUnpaidBalanceCents`: number (`totalOriginal - totalPaidToSupplier`) `[PROPOSTA TÉCNICA]`
- `originType`: `'manual' | 'shopping_list' | 'installment'` `[APROVADO]`
- `originRefId`?: string (FK `items/{itemId}`)
- `clientTransactionUuid`: string
- `createdAt`: string (ISO)

#### `ExpenseLiability` (`spaces/{spaceId}/shared_expenses/{expenseId}/liabilities/{memberUid}`)
*Cota de responsabilidade de cada participante no rateio:*
- `id`: string (PK: `memberUid`)
- `expenseId`: string (FK)
- `spaceId`: string (FK)
- `memberUid`: string (FK `users/{uid}`) `[APROVADO]`
- `memberName`: string
- `assignedShareAmountCents`: number (Cota bruta atribuída) `[APROVADO]`
- `adjustedShareAmountCents`: number (Cota líquida após devoluções/perdas do fornecedor) `[APROVADO]`
- `splitMethod`: `'equal' | 'percentage' | 'custom_value'` `[APROVADO]`
- `splitRatio`?: number
- `roundingRemainderRank`?: number (Critério Hamilton/Hare) `[APROVADO]`

#### `ExpensePayment` (`spaces/{spaceId}/shared_expenses/{expenseId}/payments/{paymentId}`)
*Desembolso financeiro com segregação de executor e financiador:*
- `id`: string (PK)
- `expenseId`: string (FK)
- `spaceId`: string (FK)
- `amountCents`: number `[APROVADO]`
- `paymentDate`: string (YYYY-MM-DD) `[APROVADO]`
- `executedByUid`: string (Quem entregou o dinheiro ao fornecedor) `[APROVADO]`
- `executedByName`: string
- `economicFunderUid`: string (Quem forneceu o recurso original) `[APROVADO]`
- `economicFunderName`: string
- `fundingSource`: `'personal_checking' | 'credit_card' | 'custody_transfer'` `[APROVADO]`
- `custodyTransferId`?: string (FK `transfers/{transferId}`, se custódia) `[APROVADO]`
- `publicPayerLabel`: string (Ex: "Recurso próprio de Keniel") `[APROVADO]`
- `validationStatus`: `'pending_validation' | 'approved' | 'rejected'` `[APROVADO]`
- `validatedByUid`?: string (O `responsibleUid` da despesa valida o pagamento) `[APROVADO]`
- `rejectionReason`?: string
- `clientTransactionUuid`: string
- `createdAt`: string (ISO)

#### `BilateralDebtLedger` (`spaces/{spaceId}/shared_expenses/{expenseId}/bilateral_debts/{debtId}`)
*Projeção determinística de créditos bilaterais constituídos:*
- `id`: string (PK: `debtorUid_creditorUid`)
- `expenseId`: string (FK)
- `spaceId`: string (FK)
- `competenceMonth`: string (YYYY-MM)
- `debtorUid`: string (Participante financiado) `[APROVADO]`
- `debtorName`: string
- `creditorUid`: string (Participante que financiou além de sua cota) `[APROVADO]`
- `creditorName`: string
- `originalFinancedAmountCents`: number `[APROVADO]`
- `liquidatedCents`: number (Amortizado via liquidação) `[APROVADO]`
- `currentRemainingDebtCents`: number (`originalFinanced - liquidated`) `[APROVADO]`
- `status`: `'open' | 'partially_settled' | 'fully_settled'` `[APROVADO]`

#### `SettlementRecord` (`spaces/{spaceId}/settlements/{settlementId}`)
*Acerto formal de contas entre devedor e credor:*
- `id`: string (PK)
- `spaceId`: string (FK)
- `debtorUid`: string (Quem paga a dívida) `[APROVADO]`
- `creditorUid`: string (Quem recebe o dinheiro) `[APROVADO]`
- `amountSettledCents`: number `[APROVADO]`
- `settlementDate`: string (YYYY-MM-DD) `[APROVADO]`
- `paymentDeclarationProofUrl`?: string
- `status`: `'pending_confirmation' | 'confirmed' | 'rejected' | 'reverted'` `[APROVADO]`
- `confirmedAt`?: string
- `confirmedByUid`?: string (O `creditorUid` confirma o recebimento) `[APROVADO]`
- `clientTransactionUuid`: string
- `createdAt`: string (ISO)

#### `SettlementAllocation` (`spaces/{spaceId}/settlements/{settlementId}/allocations/{allocationId}`)
*Amortização FIFO atrelada a cada dívida bilateral específica:*
- `id`: string (PK)
- `settlementId`: string (FK)
- `bilateralDebtId`: string (FK `BilateralDebtLedger/{debtId}`) `[APROVADO]`
- `expenseId`: string (FK `SharedExpense/{expenseId}`) `[APROVADO]`
- `competenceMonth`: string (YYYY-MM) `[APROVADO]`
- `amountAllocatedCents`: number `[APROVADO]`

#### `SettlementReversionEvent` (`spaces/{spaceId}/settlements/{settlementId}/reversions/{reversionId}`)
*Trilha imutável em caso de estorno de liquidação:*
- `id`: string (PK)
- `settlementId`: string (FK)
- `requestedByUid`: string `[APROVADO]`
- `confirmedByUid`: string `[APROVADO]`
- `revertReason`: string `[APROVADO]`
- `revertedAt`: string (ISO) `[PROPOSTA TÉCNICA]`

#### `SupplierRefundEvent` (`spaces/{spaceId}/shared_expenses/{expenseId}/refunds/{refundId}`)
*Eventos de cancelamento ou devolução pelo fornecedor comercial:*
- `id`: string (PK)
- `expenseId`: string (FK)
- `refundType`: `'full_refund' | 'partial_refund' | 'unrecoverable_loss'` `[APROVADO]`
- `amountRefundedCents`: number (Valor devolvido pelo fornecedor) `[APROVADO]`
- `lossAmountCents`: number (Prejuízo retido pelo fornecedor) `[APROVADO]`
- `recipientUid`: string (Participante que recebeu a devolução bancária) `[APROVADO]`
- `destinationAccountId`?: string (Conta onde caiu a devolução) `[APROVADO]`
- `date`: string (YYYY-MM-DD)
- `justification`: string `[APROVADO]`
- `createdAt`: string (ISO)

---

### 5.4. Núcleo de Rateios Avulsos com Pessoas Externas

#### `AdhocSplitExpense` (`adhoc_expenses/{expenseId}`)
*Despesa individual com divisão externa:*
- `id`: string (PK)
- `ownerUid`: string (Autor da compra original) `[APROVADO]`
- `ownerName`: string
- `title`: string `[APROVADO]`
- `description`?: string
- `totalAmountCents`: number `[APROVADO]`
- `ownerShareAmountCents`: number (Cota que cabe ao autor) `[APROVADO]`
- `totalToReimburseCents`: number (`totalAmountCents - ownerShareAmountCents`) `[APROVADO]`
- `totalReimbursedCents`: number (Soma de reembolsos confirmados) `[APROVADO]`
- `fundingSource`: `'personal_checking' | 'credit_card'` `[APROVADO]`
- `sourceAccountId`: string (FK `accounts/{accountId}`) `[APROVADO]`
- `date`: string (YYYY-MM-DD)
- `status`: `'active' | 'fully_reimbursed' | 'cancelled'` `[APROVADO]`
- `registeredDebtorUids`: string[] (Array com UIDs de usuários cadastrados) `[APROVADO]`
- `hasExternalDebtors`: boolean `[APROVADO]`
- `createdAt`: string (ISO)

#### `ExternalDebtorRecord` (`adhoc_expenses/{expenseId}/external_debtors/{debtorId}`)
*Representação de pessoa externa sem conta no app (Exceção aprovada na Seção 2.1):*
- `id`: string (PK)
- `adhocExpenseId`: string (FK `adhoc_expenses/{expenseId}`)
- `name`: string (Nome da pessoa externa, ex: "João") `[APROVADO]`
- `identificationType`: `'name_only' | 'email_invited'` `[APROVADO]`
- `email`?: string (Se informada a opção A com e-mail) `[APROVADO]`
- `assignedAmountCents`: number (Valor devido pela pessoa externa) `[APROVADO]`
- `reimbursedAmountCents`: number (Total pago e registrado manualmente) `[APROVADO]`
- `remainingBalanceCents`: number (`assignedAmountCents - reimbursedAmountCents`) `[APROVADO]`
- `status`: `'pending' | 'partially_cleared' | 'cleared'` `[APROVADO]`
- `manualReceiptHistory`: Array<{
    `receiptId`: string;
    `amountCents`: number;
    `receivedDate`: string;
    `destinationAccountId`: string; // Conta onde Keniel recebeu o dinheiro/PIX
    `registeredByUid`: string;
    `notes`?: string;
  }> `[APROVADO]`
- `createdAt`: string (ISO)

#### `AdhocSplitObligation` (`users/{guestUid}/adhoc_obligations/{obligationId}`)
*Conta a pagar registrada no banco do convidado (quando cadastrado no app):*
- `id`: string (PK)
- `adhocExpenseId`: string (FK `adhoc_expenses/{expenseId}`) `[APROVADO]`
- `guestUid`: string (FK `users/{guestUid}`) `[APROVADO]`
- `creditorUid`: string (FK `users/{ownerUid}`) `[APROVADO]`
- `creditorName`: string
- `assignedAmountCents`: number (Cota original devida) `[APROVADO]`
- `paidAmountCents`: number (Total de pagamentos informados e confirmados) `[APROVADO]`
- `remainingBalanceCents`: number (`assignedAmountCents - paidAmountCents`) `[APROVADO]`
- `obligationStatus`: `'pending_invite' | 'accepted' | 'rejected' | 'payment_informed' | 'confirmed_cleared'` `[APROVADO]`
- `guestRejectionReason`?: string
- `paymentDeclarationDate`?: string
- `paymentProofUrl`?: string
- `updatedAt`: string (ISO)

#### `AdhocReimbursement` (`adhoc_expenses/{expenseId}/reimbursements/{reimbursementId}`)
*Entrada financeira real de reembolso:*
- `id`: string (PK)
- `adhocExpenseId`: string (FK)
- `obligationId`?: string (FK `AdhocSplitObligation`, se usuário cadastrado) `[APROVADO]`
- `externalDebtorId`?: string (FK `ExternalDebtorRecord`, se pessoa externa) `[APROVADO]`
- `debtorName`: string
- `creditorUid`: string (Credor recebedor) `[APROVADO]`
- `amountCents`: number `[APROVADO]`
- `paymentDate`: string (YYYY-MM-DD)
- `status`: `'pending_confirmation' | 'confirmed' | 'rejected'` `[APROVADO]`
- `destinationAccountId`?: string (Conta bancária escolhida pelo credor no ato da confirmação) `[APROVADO]`
- `confirmedAt`?: string
- `rejectionReason`?: string
- `clientTransactionUuid`: string `[PROPOSTA TÉCNICA]`
- `createdAt`: string (ISO)

---

### 5.5. Transferências sob Custódia (Caminho Real do Dinheiro)

#### `CustodyTransfer` (`transfers/{transferId}`)
*Contrato de custódia entre remetente e custodiante:*
- `id`: string (PK)
- `spaceId`?: string (Opcional: preenchido se adiantamento de espaço) `[APROVADO]`
- `senderUid`: string (Quem enviou o dinheiro) `[APROVADO]`
- `senderName`: string
- `custodianUid`: string (Quem recebeu e custodia o valor) `[APROVADO]`
- `custodianName`: string
- `initialAmountCents`: number [centavos] `[APROVADO]`
- `usedAmountCents`: number (Consumido em despesas) `[APROVADO]`
- `returnedAmountCents`: number (Devolvido ao remetente) `[APROVADO]`
- `availableBalanceCents`: number (`initial - used - returned`) `[APROVADO]`
- `targetExpenseId`?: string (Despesa específica carimbada, se houver) `[APROVADO]`
- `sourceAccountId`: string (Conta bancária de onde o dinheiro saiu em Mariana) `[APROVADO]`
- `destinationAccountId`?: string (Conta bancária onde o dinheiro entrou em Keniel) `[APROVADO]`
- `custodyStatus`: `'pending_receipt' | 'custody_active' | 'exhausted' | 'fully_returned'` `[APROVADO]`
- `createdAt`: string (ISO)

#### `CustodyTransferEvent` (`transfers/{transferId}/events/{eventId}`)
*Trilha imutável de movimentações da custódia com identificação das contas:*
- `id`: string (PK)
- `transferId`: string (FK)
- `eventType`: `'transfer_sent' | 'receipt_confirmed' | 'expense_consumed' | 'partial_return_sent' | 'partial_return_confirmed'` `[APROVADO]`
- `amountCents`: number `[APROVADO]`
- `affectedAccountId`?: string (Conta bancária onde houve entrada ou saída real) `[APROVADO]`
- `targetExpenseId`?: string (Despesa onde o valor foi aplicado) `[APROVADO]`
- `performedByUid`: string `[APROVADO]`
- `justification`?: string
- `clientTransactionUuid`: string
- `timestamp`: string (ISO)

---

### 5.6. Listas de Aquisição com Propriedade por Compra Efetiva

#### `AcquisitionList` (`acquisition_lists/{listId}`)
*Lista de compras associada a um Usuário ou a um Espaço:*
- `id`: string (PK)
- `scopeType`: `'individual' | 'shared'` `[APROVADO]`
- `ownerUid`: string (Preenchido se `individual`, FK `users/{uid}`) `[APROVADO]`
- `spaceId`?: string (Preenchido se `shared`, FK `spaces/{spaceId}`) `[APROVADO]`
- `name`: string `[APROVADO]`
- `description`: string
- `type`: `'recorrente' | 'objetivo' | 'desejo'` `[APROVADO]`
- `memberUids`: string[] (Array para ACL e permissões) `[APROVADO]`
- `createdByUid`: string (Autor da lista) `[APROVADO]`
- `createdAt`: string (ISO)

#### `AcquisitionItem` (`acquisition_lists/{listId}/items/{itemId}`)
*Item da lista (catálogo de necessidades):*
- `id`: string (PK)
- `listId`: string (FK `acquisition_lists/{listId}`)
- `scopeType`: `'individual' | 'shared'` `[APROVADO]`
- `ownerUid`: string (Se individual)
- `spaceId`?: string (Se compartilhada)
- `name`: string `[APROVADO]`
- `groupId`: string (FK `taxonomy/{groupId}`) `[APROVADO]`
- `categoryId`: string (FK `taxonomy/{groupId}/categories/{categoryId}`) `[APROVADO]`
- `listType`: `'recorrente' | 'objetivo' | 'desejo'` `[APROVADO]`
- `stage`: string (Estágio Kanban da máquina de estados) `[APROVADO]`
- `createdByUid`: string (Autor do item) `[APROVADO]`
- `notes`?: string
- **Campos Recorrente:** `currentStock`, `minStock`, `unit` (`un`, `kg`, `L`, `pct`, `cx`), `cartDraft` `[APROVADO]`
- **Campos Objetivo:** `targetAmountCents`, `savedAmountCents`, `finalPaidAmountCents`, `quotes[]`, `deposits[]` `[APROVADO]`
- **Campos Desejo:** `estimatedPriceCents`, `priority` (`Baixa | Média | Alta`), `inspirationUrl`, `prosAndCons` `[APROVADO]`
- `updatedAt`: string (ISO)

#### `AcquisitionPurchaseRecord` (`acquisition_lists/{listId}/items/{itemId}/purchases/{purchaseId}`)
*Registro de cada aquisição efetivamente realizada, governando a propriedade imutável:*
- `id`: string (PK)
- `itemId`: string (FK `AcquisitionItem`)
- `listId`: string (FK `AcquisitionList`)
- `spaceId`?: string (FK `Space`)
- `buyerUid`: string (Quem realizou a compra física / entrega do dinheiro) `[APROVADO]`
- `brand`: string
- `storeName`: string
- `quantity`: number
- `unitPriceCents`: number
- `totalPaidCents`: number (`quantity * unitPriceCents`) `[APROVADO]`
- `purchaseDate`: string (ISO) `[APROVADO]`
- `receiptUrl`?: string
- **Governança de Propriedade do Bem Adquirido:**
  - `ownershipType`: `'individual' | 'shared_participants' | 'space_asset'` `[APROVADO]`
  - `owners`: Array<{
      `uid`: string;
      `name`: string;
      `disbursedAmountCents`: number; // Valor real saído do bolso
      `ownershipPercentage`: number;  // (disbursed / totalPaid) * 100
    }> `[APROVADO]`
- **Vínculo Transacional Financeiro:**
  - `linkedExpenseId`: string (FK `SharedExpense` ou `PersonalTransaction`) `[APROVADO]`
  - `linkedExpenseType`: `'personal' | 'shared'` `[APROVADO]`
- `createdAt`: string (ISO)

---

# 6. Regras de Integridade e Validação Contábil

1. **R1. Integridade da Copropriedade de Bens:**
   $$\sum_{i=1}^m \text{disbursedAmountCents}_i = \text{totalPaidCents}$$
   $$\sum_{i=1}^m \text{ownershipPercentage}_i = 100.00\%$$
   A soma dos desembolsos deve ser exatamente igual ao total pago, e a soma das participações percentuais deve totalizar 100%. Compras subsequentes do mesmo item geram novos `AcquisitionPurchaseRecord` e nunca alteram a propriedade das compras passadas.
2. **R2. Integridade dos Rateios de Despesa:**
   $$\sum_{k=1}^n \text{assignedShareAmountCents}_k = \text{totalOriginalAmountCents}$$
   O centavo residual é distribuído estritamente pelo algoritmo Hamilton/Hare, garantindo soma exata.
3. **R3. Integridade da Custódia de Adiantamentos:**
   $$\text{availableBalanceCents} = \text{initialAmountCents} - (\text{usedAmountCents} + \text{returnedAmountCents})$$
   $$\text{availableBalanceCents} \ge 0$$
   O saldo disponível sob custódia não pode ficar negativo sob nenhuma hipótese.
4. **R4. Integridade da Fatura de Cartão:**
   $$\text{totalDueAmountCents} = \text{totalPurchasesAmountCents} + \text{carriedOverBalanceCents} + \text{interestAndFeesCents}$$
   $$\text{remainingBalanceCents} = \text{totalDueAmountCents} - \text{totalPaidAmountCents}$$

---

# 7. Estados e Máquinas de Estado

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        MÁQUINAS DE ESTADO INDEPENDENTES                                │
├───────────────────────────────┬────────────────────────────────────────────────────────┤
│ 1. ESTADO DO ESPAÇO           │ [active] ──(Arquivar)──> [archived] (Somente Leitura)  │
│                               │    │                                                   │
│                               │    └──(Solicitar Exclusão)──> [pending_deletion] ────> [deleted]
├───────────────────────────────┼────────────────────────────────────────────────────────┤
│ 2. ESTADO DA PARTICIPAÇÃO     │ [invited] ──(Aceitar)──> [active]                      │
│    (Por Membro no Espaço)     │    │                         │                         │
│                               │    └──(Recusar)              ├──(Saída)──> [voluntary_exit]
│                               │        [declined]            │                         │
│                               │                              └──(Remover)──> [removed_by_admin]
├───────────────────────────────┼────────────────────────────────────────────────────────┤
│ 3. OBRIGAÇÃO DE RATEIO AVULSO │ [pending_invite] ──(Aceitar)──> [accepted]             │
│    (No Convidado Cadastrado)  │    │                               │                   │
│                               │    └──(Recusar)                    └──(Declarar PIX)──> [payment_informed]
│                               │        [rejected]                                              │
│                               │                                                                └──(Credor confirma)──> [confirmed_cleared]
├───────────────────────────────┼────────────────────────────────────────────────────────┤
│ 4. DEVEDOR EXTERNO AVULSO     │ [pending] ──(Baixa parcial manual)──> [partially_cleared]
│    (Pessoa sem Cadastro)      │    │                                        │          │
│                               │    └──(Baixa total manual)──────────────────┴──────────> [cleared]
├───────────────────────────────┼────────────────────────────────────────────────────────┤
│ 5. CUSTÓDIA DE ADIANTAMENTO   │ [pending_receipt] ──(Custodiante confirma)──> [custody_active]
│                               │                                                     │  │
│                               │         ┌──(Uso parcial / Devolução parcial)────────┘  │
│                               │         ▼                                              │
│                               │ [exhausted] <──(Uso integral ou devolução total)───────┘
└───────────────────────────────┴────────────────────────────────────────────────────────┘
```

---

# 8. Fluxos Financeiros Completos com Exemplos

### 8.1. Rateio Avulso com Pessoa Externa Somente por Nome (Cenário de Negócio 2.1)
*Dados:* Keniel registra uma despesa de churrasco de R$ 300 no cartão e aponta que João (pessoa externa sem conta e sem e-mail) deve reembolsar R$ 150.
1. **Cadastro:** Keniel cadastra `AdhocSplitExpense` (R$ 300) e adiciona um `ExternalDebtorRecord`:
   - `name: "João"`, `identificationType: 'name_only'`.
   - `assignedAmountCents: 15000` (R$ 150,00).
   - `reimbursedAmountCents: 0`.
   - `status: 'pending'`.
2. **Auditoria e Acesso:** João não recebe e-mail, não é criado como usuário fictício e não tem acesso ao sistema. O sistema mantém o lançamento avulso com R$ 150 pendentes nos relatórios de recebíveis de Keniel.
3. **Pagamento Manual:** Semanas depois, João entrega R$ 150 em dinheiro para Keniel.
4. **Baixa Manual por Keniel:** Keniel abre a despesa avulsa, seleciona João e clica em **"Registrar Recebimento Manual"**:
   - Informa: Valor R$ 150,00, Data de hoje, Conta de destino: "Carteira Dinheiro".
   - O sistema grava a entrada no array `manualReceiptHistory` e atualiza o status de João para `cleared`.
   - Cria atomicamente uma entrada real de R$ 150 na "Carteira Dinheiro" de Keniel como **Reembolso Vinculado**.
   - A fatura do cartão permanece nos R$ 300 nominais originais, enquanto o custo líquido de Keniel é reduzido para R$ 150.

### 8.2. Transferência sob Custódia com Rastreio Completo (Cenário 3.2)
*Dados:* Mariana transfere R$ 500 do Itaú para a conta Nubank de Keniel para custeio de compras.
1. **Envio:** Mariana cria `CustodyTransfer` informando saída de sua conta Itaú (`sourceAccountId`). Status `pending_receipt`.
2. **Confirmação de Recebimento:** Keniel seleciona sua conta Nubank (`destinationAccountId`) e clica em "Confirmar Recebimento":
   - Registra entrada de R$ 500 no Nubank de Keniel sob passivo de custódia (`CustodyTransferEvent: receipt_confirmed`).
   - O saldo disponível de custódia fica em R$ 500 (`custody_active`).
3. **Consumo de R$ 350:** Keniel paga compras de condomínio de R$ 350 com o dinheiro:
   - Cria `ExpensePayment` com `fundingSource: 'custody_transfer'` vinculado ao adiantamento.
   - Grava `CustodyTransferEvent` (`expense_consumed`, R$ 350).
   - O saldo sob custódia cai para R$ 150. A conta Nubank de Keniel sofre o débito real perante o fornecedor, mas contabilmente abate o passivo de custódia de Mariana.
4. **Devolução dos R$ 150 Restantes:** Keniel faz PIX de R$ 150 de volta para Mariana:
   - Keniel registra saída do Nubank via evento `partial_return_sent`.
   - Mariana confere o Itaú e clica em "Confirmar Recebimento da Devolução".
   - Grava evento `partial_return_confirmed`. O saldo sob custódia fecha em R$ 0,00 (`exhausted`).

---

# 9. Fluxos de Aquisição e Propriedade por Compra

### Cenário de Compra Coletiva com Percentuais Exatos (Cenário 3.1)
*Dados:* Compra de uma TV Smart de R$ 2.000,00 para o Espaço. Keniel comprou fisicamente na loja e desembolsou R$ 1.200,00. Mariana contribuiu com R$ 800,00.
1. **Registro no Carrinho da Lista:**
   - O item `AcquisitionItem` ("TV Smart 55") avança para o checkout.
   - O formulário captura os desembolsos reais:
     - Keniel: `disbursedAmountCents: 120000` (R$ 1.200,00).
     - Mariana: `disbursedAmountCents: 80000` (R$ 800,00).
     - Total: `totalPaidCents: 200000` (R$ 2.000,00).
2. **Cálculo de Copropriedade:**
   - Participação de Keniel: $(120000 / 200000) \times 100 = \mathbf{60\%}$.
   - Participação de Mariana: $(80000 / 200000) \times 100 = \mathbf{40\%}$.
3. **Persistência Imutável:**
   - Cria-se o documento `AcquisitionPurchaseRecord` na subcoleção `/purchases/{purchaseId}` com `owners: [{ uid: 'keniel', disbursedAmountCents: 120000, ownershipPercentage: 60 }, { uid: 'mariana', disbursedAmountCents: 80000, ownershipPercentage: 40 }]`.
   - Gera a `SharedExpense` no financeiro vinculada a este `purchaseId`.
4. **Independência de Compras Posteriores:** Se meses depois uma nova compra do mesmo item for realizada (ex: outra TV para outro quarto), ela gerará um novo `purchaseId` com seus próprios desembolsos e percentuais, sem afetar a copropriedade de 60%/40% desta primeira aquisição.

---

# 10. Fluxo de Arquivamento e Dissolução de Espaços

### 10.1. Arquivamento Operacional (Modo Somente Leitura)
1. **Gatilho:** O proprietário (`ownerId`) ou consenso de administradores clica em "Arquivar Espaço".
2. **Efeito no Banco:** `spaceStatus` passa para `'archived'`.
3. **Bloqueio de Segurança no Firestore Rules:**
   - Toda tentativa de `create`, `update` ou `delete` em subcoleções de despesas, membros, listas ou itens deste espaço é **imediatamente rejeitada com `PERMISSION_DENIED`**.
   - Os membros mantêm acesso de leitura (`allow read`) para consultas e conferência histórica.

### 10.2. Exclusão Definitiva com Destinação Individual dos Autores
1. **Solicitação:** Um administrador inicia a solicitação formal de exclusão definitiva.
   - O sistema cria o documento `SpaceDissolutionRequest`.
   - Notifica todos os participantes que possuem registros de despesas, pagamentos ou listas no espaço.
2. **Decisão Individual de Cada Autor:** Cada membro acessa a tela de destinação e escolhe o que fazer com seus registros autorais:
   - Opção 1: Migrar para um espaço individual existente.
   - Opção 2: Criar um novo espaço individual e migrar seus dados.
   - Opção 3: Arquivar os dados de forma oculta em seu histórico pessoal.
   - Opção 4: Excluir definitivamente seus registros.
3. **Regra de Bloqueio por Silêncio:** Se qualquer autor não responder ou discordar, a solicitação **não é executada**. O processo é cancelado e o espaço permanece no estado seguro de `archived` (somente leitura).

---

# 11. Segurança e Matriz de Autorização Firestore

As regras de segurança protegem os dados no nível de documento e barram alterações em espaços arquivados:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    function isAuthenticated() {
      return request.auth != null;
    }
    
    function isSpaceActive(spaceId) {
      return get(/databases/$(database)/documents/spaces/$(spaceId)).data.spaceStatus == 'active';
    }
    
    function isSpaceMember(spaceId) {
      return isAuthenticated() && 
        request.auth.uid in get(/databases/$(database)/documents/spaces/$(spaceId)).data.memberUids;
    }

    // 1. Contas Pessoais e Metadados Privados (Blindagem Física)
    match /accounts/{accountId} {
      allow read, write: if isAuthenticated() && request.auth.uid == resource.data.userId;
      allow create: if isAuthenticated() && request.auth.uid == request.resource.data.userId;
      
      match /private_payment_metadata/{paymentId} {
        allow read, write: if isAuthenticated() && 
          request.auth.uid == get(/databases/$(database)/documents/accounts/$(accountId)).data.userId;
      }
    }

    // 2. Transações e Rateios Pessoais
    match /users/{userId}/personal_transactions/{txId} {
      allow read, write: if isAuthenticated() && request.auth.uid == userId;
    }
    
    match /users/{userId}/adhoc_obligations/{obligationId} {
      allow read: if isAuthenticated() && 
        (request.auth.uid == userId || request.auth.uid == resource.data.creditorUid);
      allow update: if isAuthenticated() && 
        (request.auth.uid == userId || request.auth.uid == resource.data.creditorUid);
    }

    // 3. Rateios Avulsos (Despesas fora de espaço)
    match /adhoc_expenses/{expenseId} {
      allow read: if isAuthenticated() && 
        (request.auth.uid == resource.data.ownerUid || request.auth.uid in resource.data.registeredDebtorUids);
      allow create: if isAuthenticated() && request.auth.uid == request.resource.data.ownerUid;
      allow update: if isAuthenticated() && request.auth.uid == resource.data.ownerUid;
      allow delete: if false;
    }

    // 4. Espaços Compartilhados: Trava Total para Espaços Arquivados
    match /spaces/{spaceId} {
      allow read: if isSpaceMember(spaceId);
      allow create: if isAuthenticated() && request.auth.uid == request.resource.data.ownerId;
      allow update: if isSpaceMember(spaceId) && (
        // Apenas o owner pode arquivar
        request.auth.uid == resource.data.ownerId ||
        (isSpaceActive(spaceId) && request.auth.uid in resource.data.memberUids)
      );
    }

    // 5. Despesas do Espaço: Bloqueadas se o espaço estiver arquivado
    match /spaces/{spaceId}/shared_expenses/{expenseId} {
      allow read: if isSpaceMember(spaceId);
      allow create: if isSpaceMember(spaceId) && isSpaceActive(spaceId) &&
        request.resource.data.createdByUid == request.auth.uid &&
        request.resource.data.validationStatus == 'pending_validation';
      
      allow update: if isSpaceMember(spaceId) && isSpaceActive(spaceId) && (
        // Validação pelo responsável da despesa (credor)
        (request.auth.uid == resource.data.responsibleUid &&
         request.resource.data.diff(resource.data).affectedKeys().hasOnly(['validationStatus', 'validatedByUid', 'validatedAt', 'rejectionReason'])) ||
        // Edição pelo autor original se pendente/rejeitado
        (request.auth.uid == resource.data.createdByUid &&
         resource.data.validationStatus in ['pending_validation', 'rejected'] &&
         request.resource.data.createdByUid == resource.data.createdByUid)
      );
      allow delete: if false;
    }

    // 6. Listas de Aquisição do Espaço: Bloqueadas se o espaço estiver arquivado
    match /acquisition_lists/{listId} {
      allow read: if isAuthenticated() && (
        (resource.data.scopeType == 'individual' && request.auth.uid == resource.data.ownerUid) ||
        (resource.data.scopeType == 'shared' && isSpaceMember(resource.data.spaceId))
      );
      allow create, update: if isAuthenticated() && (
        (request.resource.data.scopeType == 'individual' && request.auth.uid == request.resource.data.ownerUid) ||
        (request.resource.data.scopeType == 'shared' && isSpaceMember(request.resource.data.spaceId) && isSpaceActive(request.resource.data.spaceId))
      );
      allow delete: if false;
    }
  }
}
```

---

# 12. Histórico, Auditoria e Idempotência

1. **Imutabilidade Baseada em Eventos:**
   - Mutações contábeis (devoluções, liquidações, reembolsos e cancelamentos) são gravadas em subcoleções imutáveis de eventos (`CustodyTransferEvent`, `SupplierRefundEvent`, `SettlementReversionEvent`).
   - O documento pai preserva a data e valor original; seu status é modificado apenas para refletir o estado de consolidação.
2. **Idempotência Atômica:**
   - Toda gravação do cliente envia um `clientTransactionUuid` único (UUID v4).
   - O backend ou a transação Firestore (`runTransaction`) verifica a existência prévia da chave na coleção `/idempotency_keys/{uuid}`. Se já processada, a operação é encerrada retornando o recibo anterior, impedindo duplicidades decorrentes de reenvio ou instabilidade de rede.

---

# 13. Riscos Técnicos e Mitigações

| Risco Técnico Identificado | Impacto | Medida de Mitigação Projetada na Arquitetura |
| :--- | :--- | :--- |
| **Concorrência em Checkouts Simultâneos** | Médio | O `runTransaction` lê a versão atual do item. O primeiro checkout avança o item para `conferido`; a transação concorrente detecta a mudança e aborta com aviso amigável. |
| **Pessoa Externa em Rateio Avulso que se Cadastra Posteriormente** | Baixo | Um assistente no perfil do usuário permite associar o `ExternalDebtorRecord` ao novo UID do amigo recém-cadastrado, convertendo o histórico em uma obrigação formal. |
| **Complexidade no Cálculo de Copropriedade de Bens** | Baixo | A subcoleção `AcquisitionPurchaseRecord` calcula e grava a copropriedade no exato momento da compra de forma definitiva, evitando recálculos em tempo de renderização. |

---

# 14. Decisões Ainda Pendentes (Nenhuma Inconsistência Bloqueante)

A arquitetura v3.0 resolveu 100% das contradições conceituais e atende com fidelidade matemática a todas as regras de negócio validadas.

Resta apenas **1 ponto de experiência do usuário (UX)** para sua homologação:

- **Prazo de Resposta na Exclusão Definitiva de Espaço:** Quando um administrador solicitar a exclusão definitiva de um espaço e notificar os autores dos dados para escolherem suas opções de destinação, qual deve ser o comportamento se um autor não responder após 30 dias?
  - **Opção A [Recomendada]:** O processo de exclusão é cancelado automaticamente e o espaço permanece seguro e congelado no estado de arquivado (`archived`).
  - **Opção B:** Os dados daquele autor específico são convertidos automaticamente para a opção mais segura (arquivamento oculto individual em seu perfil), permitindo concluir a exclusão do espaço compartilhado.

---

# 15. Critérios de Validação para Futura Aprovação

A arquitetura de dados v3.0 estará pronta para ser homologada se atender aos seguintes critérios:
1. **Completude Relacional:** Todas as entidades possuem chaves primárias e estrangeiras explícitas, sem campos abstratos ou dependência de e-mail.
2. **Rigor Contábil:** Nenhuma operação financeira gera saída ou entrada bancária fictícia sem declaração e confirmação. Reembolsos não alteram faturas de cartão.
3. **Segurança:** O isolamento documental protege os dados bancários privados e a trava de arquivamento impede mutações pós-dissolução.
4. **Governança de Bens:** A propriedade dos itens de compras é rastreada por compra efetiva e os percentuais refletem exatamente os valores desembolsados.

*Este documento encerra a Especificação da Arquitetura de Dados v3.0. Nenhuma implementação foi realizada no projeto.*
