# Especificação Arquitetural e Contábil Definitiva (v3.0)
## Sistema Financeiro de Espaços Compartilhados e Finanças Pessoais Integradas

**Documento Oficial de Engenharia de Software e Contabilidade Analítica**  
**Status:** Revisão Técnica Final Submetida para Aprovação do Usuário  
**Autorização de Implementação:** NÃO AUTORIZADA (Documento Estritamente Normativo e Conceitual)  
**Data:** 09 de Novembro de 2026

---

# BLOCO A: Matriz de Correções e Ajustes

| Item Apontado no Feedback | Problema Técnico Anterior | Solução Definitiva Adotada | Entidades e Regras Afetadas | Impacto Arquitetural | Exige Decisão do Usuário? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **2.1. Créditos Bilaterais e Múltiplos Pagadores** | `ExpenseObligation` assumia um credor fixo e estático na própria dívida, quebrando em rateios com 3+ membros ou pagamentos múltiplos. | Separação em 3 camadas: (1) Responsabilidade bruta individual; (2) Pagamentos realizados e auto-cobertura; (3) Tabela relacional de débitos e créditos bilaterais (`BilateralDebtLedger`), calculada deterministicamente. | `SharedExpense`, `ExpenseLiability`, `ExpensePayment`, `BilateralDebtLedger`. | Permite suportar qualquer combinação de participantes pagadores e devedores com rastreabilidade atômica. | **Não** (Implementado conforme diretriz). |
| **2.2. Efeitos Financeiros por Fonte de Pagamento** | Todos os pagamentos eram modelados como se provocassem saída bancária imediata no momento do registro. | Matriz estrita de efeitos: Conta Corrente debita na hora; Cartão gera débito futuro na fatura; Fundo Coletivo consome a reserva sem débito bancário; Adiantamento consome o saldo custodiado sem nova saída bancária. | `ExpensePayment`, `Account`, `CreditCardInvoice`, `SharedResourcePool`. | Elimina 100% dos riscos de duplicidade contábil e de conciliação bancária. | **Não** (Regra fechada). |
| **2.3. Ciclo de Vida de Adiantamentos** | Adiantamento possuía apenas campos numéricos estáticos de saldo, sem trilha de auditoria histórica de movimentações. | Criação da subcoleção imutável `advance_events` registrando: criação, entrada bancária, aprovação, utilizações parciais, devoluções, reversões e conversões. | `AdvanceTransfer`, `AdvanceEvent`. | Total auditabilidade e rastreio de custódia temporária de valores de terceiros. | **Não** (Regra fechada). |
| **2.4. Recursos Coletivos (Fundo de Reserva)** | A utilização do fundo gerava abatimento de supostas "cotas individuais" dos participantes. | O Fundo é formalizado como **Patrimônio Coletivo Indivisível**. Sua utilização quita a despesa perante o fornecedor sem criar dívidas ou cotas entre os participantes. | `SharedResourcePool`, `ResourceMovementEvent`, `SharedExpense`. | A despesa existe para competência e histórico, mas financiada 100% pelo fundo comum. | **Não** (Regra fechada). |
| **2.5. Máquinas de Estado Independentes** | Estados de validação, compromisso financeiro, cancelamento e reembolso estavam misturados em enum único. | Desacoplamento em 5 máquinas de estado ortogonais: `CommitmentStatus`, `ValidationStatus`, `PaymentExecutionStatus`, `RefundStatus`, `DisputeStatus`. | `SharedExpense`, `ExpensePayment`, `SettlementRecord`. | Cobre com precisão os 6 cenários de cancelamento (perda consumada, devolução total/parcial, etc.). | **Não** (Regra fechada). |
| **2.6. Liquidações Bilaterais com FIFO Estrito** | As liquidações estavam vinculadas genericamente à despesa ou misturavam dívidas de participantes distintos. | `SettlementRecord` opera estritamente por par bilateral (Devedor A $\rightarrow$ Credor B), amortizando via subcoleção `allocations` as dívidas bilaterais mais antigas daquele par. | `SettlementRecord`, `SettlementAllocation`, `BilateralDebtLedger`. | Liquidações de múltiplos participantes tornam-se transações agrupadas de pares bilaterais isolados. | **Não** (Regra fechada). |
| **2.7. Arredondamento Hamilton / Hare** | Afirmação equivocada de que o algoritmo garantia neutralidade absoluta ao longo de infinitas operações. | Ajuste conceitual: o método garante a **distribuição exata dos centavos daquela operação específica** com desempate determinístico (hash imutável), preservando o histórico sem recalcular operações passadas. | `mathEngine`, `SharedExpense`. | Rigor matemático e auditabilidade garantidos. | **Não** (Regra fechada). |
| **3. Regras de Segurança Firestore** | O responsável podia editar qualquer campo de terceiros e o autor podia burlar status de aprovação. | Matriz de permissões com validação por campo: responsável apenas aprova/recusa com justificativa; autor edita somente em rascunho/rejeitado; campos críticos (autoria, valores aprovados) são estritamente imutáveis. | `firestore.rules`. | Segurança no nível do motor de dados, impossibilitando mutações silenciosas. | **Não** (Regra fechada). |
| **4. Idempotência Transacional** | Hash baseado em tempo arredondado de 5s gerava risco de colisões ou sobrescrita silenciosa no Firestore. | Adoção de `clientTransactionUuid` gerado na intenção do usuário, verificado e persistido atomicamente dentro de `runTransaction` na coleção `idempotency_keys`. | `idempotency_keys`, transações Firestore. | Impossibilita cliques duplos, repetições de rede ou duplicidades em qualquer cenário. | **Não** (Regra fechada). |
| **5. Migração Segura e Quarentena** | Dependência de texto `"Reembolso Livro-Razão:"` e conversão de todo `income` em aporte. | Migração em 4 fases baseada em evidências estruturais; receitas analisadas por autoria e contexto; quarentena de registros ambíguos por tempo indeterminado com tolerância zero. | `MigrationEngine`, `unresolved_legacy_transactions`. | Preservação total do legado sem riscos de perdas de histórico. | **Não** (Regra fechada). |

---

# BLOCO B: Modelo de Dados Definitivo (Firestore e TypeScript)

### B.1. Topologia das Coleções no Firestore

```
FIRESTORE ROOT
├── users/ {uid}                                         [Perfil, preferências e configurações]
├── accounts/ {accountId}                                [Contas bancárias e cartões pessoais - Restrito ao titular]
├── spaces/ {spaceId}                                    [Configurações e membros do Espaço Compartilhado]
│    ├── resource_pool/ default                          [Saldo coletivo e metadados do Fundo Livre]
│    │    └── movements/ {movementId}                    [Histórico imutável de aportes e baixas do fundo]
│    └── audit_log/ {logId}                              [Trilha de auditoria das ações no espaço]
├── shared_expenses/ {expenseId}                         [Obrigação financeira compartilhada]
│    ├── liabilities/ {liabilityId}                      [Responsabilidades brutas de cada participante]
│    ├── payments/ {paymentId}                           [Pagamentos efetuados e suas fontes]
│    ├── bilateral_debts/ {debtId}                       [Créditos e débitos gerados entre membros]
│    └── refund_events/ {refundId}                       [Eventos de cancelamento, devolução ou perda]
├── advance_transfers/ {advanceId}                       [Adiantamentos e transferências vinculadas]
│    └── events/ {eventId}                               [Histórico de utilização, devolução e conversão]
├── settlement_records/ {settlementId}                   [Liquidação de dívidas entre membros]
│    └── allocations/ {allocationId}                     [Vínculo FIFO com dívidas bilaterais específicas]
├── idempotency_keys/ {clientTransactionUuid}            [Chaves de proteção contra duplicação de transações]
├── credit_card_invoices/ {invoiceId}                    [Faturas de cartões de crédito pessoais]
│    ├── carry_overs/ {carryId}                          [Saldos transportados para faturas futuras]
│    └── installment_plans/ {planId}                     [Planos de parcelamento de fatura]
├── recurring_patterns/ {patternId}                      [Modelos de recorrência de despesas]
└── unresolved_legacy_transactions/ {legacyTxId}         [Quarentena de dados ambíguos da migração]
```

### B.2. Interfaces TypeScript Completas

```typescript
// ============================================================================
// 1. MÁQUINAS DE ESTADO (ORTOGONAIS E DESACOPLADAS)
// ============================================================================
export type ValidationStatus = 
  | 'pending_validation'  // Criada por participante comum, aguarda análise do responsável
  | 'approved'            // Aprovada pelo responsável ou autoaprovada pelo dono com log
  | 'rejected'            // Recusada pelo responsável com justificativa formal
  | 'cancelled';          // Cancelada formalmente pelo autor ou gestor

export type CommitmentStatus = 
  | 'active'              // Despesa válida em curso
  | 'closed'              // Totalmente cumprida no fornecedor e entre membros
  | 'cancelled_pre_payment' // Cancelada antes de qualquer desembolso
  | 'loss_unrecoverable'; // Cancelada no fornecedor sem reembolso (perda consumada ativa)

export type PaymentExecutionStatus = 
  | 'unpaid'              // Nenhum pagamento reconhecido
  | 'partially_paid'      // Pagamentos parciais reconhecidos no fornecedor
  | 'fully_paid';         // Totalmente quitada perante o fornecedor

export type RefundStatus = 
  | 'none'                // Nenhum estorno
  | 'full_refund'         // Devolução integral recebida do fornecedor
  | 'partial_refund';     // Devolução parcial recebida do fornecedor

// ============================================================================
// 2. DESPESA COMPARTILHADA (A OBRIGAÇÃO)
// ============================================================================
export interface SharedExpense {
  id: string;
  spaceId: string;
  title: string;
  description?: string;
  totalOriginalAmountCents: number; // Armazenamento em centavos inteiros (evita float)
  competenceMonth: string;          // YYYY-MM (mês de referência)
  competenceDate: string;           // YYYY-MM-DD (data da compra)
  dueDate?: string;                 // YYYY-MM-DD (vencimento)
  categoryId: string;
  categoryName: string;
  
  // Estados Ortogonais
  validationStatus: ValidationStatus;
  commitmentStatus: CommitmentStatus;
  paymentStatus: PaymentExecutionStatus;
  refundStatus: RefundStatus;

  // Gestão de Validação
  createdByUid: string;
  createdByName: string;
  createdAt: string;
  validatedByUid?: string;
  validatedAt?: string;
  rejectionReason?: string;
  clientTransactionUuid: string;    // Idempotência

  // Totalizadores de Pagamento Reconhecido
  totalPaidAmountCents: number;     // Soma de pagamentos com status 'approved'
  remainingBalanceCents: number;    // totalOriginalAmountCents - totalPaidAmountCents

  // Origem da Despesa
  originType: 'manual' | 'shopping_list' | 'installment_contract' | 'recurrence_instance';
  originRefId?: string;             // ID do checkout da lista ou do contrato de parcelamento
}

// ============================================================================
// 3. RESPONSABILIDADE FINANCEIRA BRUTA (CADA PARTICIPANTE)
// ============================================================================
export interface ExpenseLiability {
  id: string;                       // expenseId + '_' + memberUid
  expenseId: string;
  spaceId: string;
  memberUid: string;
  memberName: string;
  assignedShareAmountCents: number; // Cota bruta do membro nesta despesa
  adjustedShareAmountCents: number; // Ajustado pós-estornos ou perdas parciais
  splitMethod: 'equal' | 'percentage' | 'custom_value';
  splitRatio?: number;              // Porcentagem ou peso utilizado
  roundingRemainderRank?: number;   // Posição no algoritmo Hamilton/Hare
}

// ============================================================================
// 4. PAGAMENTO DA DESPESA (DESEMBOLSO)
// ============================================================================
export type PaymentFundingSource = 
  | 'personal_checking'             // Conta bancária própria (débito imediato)
  | 'credit_card'                   // Cartão de crédito (débito na fatura)
  | 'free_shared_pool'              // Fundo de Reserva Livre do Espaço
  | 'advance_transfer';             // Adiantamento vinculado sob custódia

export interface ExpensePayment {
  id: string;
  expenseId: string;
  spaceId: string;
  amountCents: number;
  paymentDate: string;
  paidByUid: string;
  paidByName: string;
  
  // Fonte do Pagamento e Privacidade
  fundingSource: PaymentFundingSource;
  privateAccountId?: string;        // ID da conta (acessível apenas pelo titular)
  publicPayerLabel: string;         // Ex: "Recurso próprio de Keniel" (visível ao grupo)
  advanceTransferId?: string;       // ID do adiantamento utilizado
  
  // Validação
  validationStatus: ValidationStatus;
  validatedByUid?: string;
  validatedAt?: string;
  rejectionReason?: string;
  proofDocumentUrl?: string;
  clientTransactionUuid: string;
  createdAt: string;
}

// ============================================================================
// 5. DÉBITOS E CRÉDITOS BILATERAIS (QUEM FINANCIOU QUEM)
// ============================================================================
export interface BilateralDebtLedger {
  id: string;                       // expenseId + '_' + debtorUid + '_' + creditorUid
  expenseId: string;
  spaceId: string;
  competenceMonth: string;
  debtorUid: string;                // Quem devia e não pagou sua cota
  debtorName: string;
  creditorUid: string;              // Quem financiou a cota de outrem (desembolsou além de sua cota)
  creditorName: string;
  originalDebtCents: number;        // Montante original do crédito bilateral nesta despesa
  liquidatedCents: number;          // Quanto já foi amortizado via SettlementRecord
  remainingDebtCents: number;       // originalDebtCents - liquidatedCents
  status: 'open' | 'partially_settled' | 'fully_settled';
}

// ============================================================================
// 6. ADIANTAMENTOS E EVENTOS DE HISTÓRICO
// ============================================================================
export interface AdvanceTransfer {
  id: string;
  spaceId: string;
  senderUid: string;
  senderName: string;
  receiverUid: string;
  receiverName: string;
  initialAmountCents: number;
  availableBalanceCents: number;
  targetExpenseId?: string;         // Despesa vinculada (se houver finalidade específica)
  validationStatus: ValidationStatus;
  status: 'available' | 'partially_used' | 'exhausted' | 'returned' | 'converted';
  createdAt: string;
}

export interface AdvanceEvent {
  id: string;
  advanceId: string;
  spaceId: string;
  eventType: 'transfer_in' | 'usage' | 'return' | 'conversion' | 'reversion';
  amountCents: number;
  date: string;
  targetExpenseId?: string;
  notes?: string;
  executedByUid: string;
  clientTransactionUuid: string;
  createdAt: string;
}

// ============================================================================
// 7. FUNDO DE RESERVA LIVRE (PATRIMÔNIO COLETIVO)
// ============================================================================
export interface SharedResourcePool {
  id: 'default';
  spaceId: string;
  currentBalanceCents: number;
  updatedAt: string;
}

export interface ResourceMovementEvent {
  id: string;
  spaceId: string;
  type: 'contribution' | 'expense_payment' | 'authorized_withdrawal' | 'reversion';
  amountCents: number;
  date: string;
  authorUid: string;
  authorName: string;
  targetExpenseId?: string;
  justification: string;
  validationStatus: ValidationStatus;
  validatedByUid?: string;
  clientTransactionUuid: string;
  createdAt: string;
}

// ============================================================================
// 8. LIQUIDAÇÃO BILATERAL E ALOCAÇÃO FIFO
// ============================================================================
export interface SettlementRecord {
  id: string;
  spaceId: string;
  debtorUid: string;                // Quem está pagando a dívida
  debtorName: string;
  creditorUid: string;              // Quem está recebendo o dinheiro
  creditorName: string;
  totalSettledAmountCents: number;
  date: string;
  sourceAccountId?: string;         // Conta de onde saiu o dinheiro (privada)
  validationStatus: ValidationStatus;
  status: 'completed' | 'reverted';
  revertReason?: string;
  revertedAt?: string;
  revertedByUid?: string;
  clientTransactionUuid: string;
  createdAt: string;
}

export interface SettlementAllocation {
  id: string;
  settlementId: string;
  bilateralDebtId: string;          // BilateralDebtLedger.id
  expenseId: string;
  competenceMonth: string;
  amountAllocatedCents: number;     // Valor abatido desta obrigação específica
  debtorUid: string;
  creditorUid: string;
}

// ============================================================================
// 9. CONTRATOS DE PARCELAMENTO E FATURAS
// ============================================================================
export interface InstallmentPurchase {
  id: string;
  spaceId: string;
  buyerUid: string;
  title: string;
  totalAmountCents: number;
  totalInstallments: number;
  firstCompetenceMonth: string;     // YYYY-MM
  status: 'active' | 'completed' | 'cancelled';
  cancelledFromInstallment?: number;
  createdAt: string;
}

export interface InvoiceCarryOver {
  id: string;
  accountId: string;                // Cartão de crédito
  fromInvoiceMonth: string;         // Mês vencido
  toInvoiceMonth: string;           // Próximo mês
  principalAmountCents: number;     // Saldo não pago transportado
  interestChargesCents: number;     // Juros/multas parametrizados
  totalCarriedCents: number;
  status: 'carried' | 'settled';
}

export interface InvoiceInstallmentPlan {
  id: string;
  accountId: string;
  fromInvoiceMonth: string;
  originalBalanceCents: number;
  installmentsCount: number;
  interestRateMonthly: number;
  installmentAmountCents: number;
  remainingInstallments: number;
  status: 'active' | 'completed' | 'early_settled';
}

// ============================================================================
// 10. RECORRÊNCIAS E AUDITORIA
// ============================================================================
export interface RecurrencePattern {
  id: string;
  spaceId: string;
  title: string;
  baseAmountCents: number;
  frequency: 'monthly' | 'yearly';
  dayOfMonth: number;
  splitRuleTemplate: any;
  status: 'active' | 'paused' | 'archived';
  createdByUid: string;
  createdAt: string;
}

export interface SpaceAuditEntry {
  id: string;
  spaceId: string;
  action: 'create' | 'validate' | 'reject' | 'revert' | 'cancel' | 'update';
  entityType: 'expense' | 'payment' | 'advance' | 'pool' | 'settlement';
  entityId: string;
  performedByUid: string;
  performedByName: string;
  timestamp: string;
  previousStateSnapshot?: any;
  newStateSnapshot?: any;
  reason?: string;
}
```

---

# BLOCO C: Máquinas de Estado e Transições

O sistema opera com máquinas de estado rigorosamente desacopladas. O cancelamento de um compromisso não destrói o histórico de pagamentos, nem a recusa de uma validação apaga o formulário do autor.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        MÁQUINAS DE ESTADO ORTOGONAIS                            │
├───────────────────────────────┬─────────────────────────────────────────────────┤
│ 1. ESTADO DE VALIDAÇÃO        │ [pending_validation] ──(Aprovar)──> [approved]  │
│    (Todas as ações de membros)│          │                                      │
│                               │          └──(Recusar com motivo)──> [rejected]  │
│                               │                                        │        │
│                               │                                        └──(Reenviar corrigido)──> [pending_validation]
├───────────────────────────────┼─────────────────────────────────────────────────┤
│ 2. ESTADO DO COMPROMISSO      │ [active] ──(Quitar integralmente)──> [closed]   │
│    (Despesa no Fornecedor)    │    │                                            │
│                               │    ├──(Cancelar antes de pagar)──> [cancelled_pre_payment]
│                               │    │                                            │
│                               │    └──(Cancelar no fornecedor sem devolução)──> [loss_unrecoverable]
├───────────────────────────────┼─────────────────────────────────────────────────┤
│ 3. ESTADO DE EXECUÇÃO         │ [unpaid] ──(Pagamento parcial)──> [partially_paid]
│    (Pagamentos Aprovados)     │    │                                    │       │
│                               │    └──(Pagamento total)─────────────────┴───────> [fully_paid]
├───────────────────────────────┼─────────────────────────────────────────────────┤
│ 4. ESTADO DE REEMBOLSO        │ [none] ──(Estorno parcial do fornecedor)──> [partial_refund]
│    (Cancelamentos de Compra)  │    │                                            │
│                               │    └──(Estorno integral do fornecedor)─────────> [full_refund]
└───────────────────────────────┴─────────────────────────────────────────────────┘
```

### Regras dos 6 Casos de Cancelamento:
1. **Cancelada antes de qualquer pagamento:** `commitmentStatus = 'cancelled_pre_payment'`, `paymentStatus = 'unpaid'`, obrigações de rateio são desativadas imediatamente.
2. **Paga com devolução integral do fornecedor:** `refundStatus = 'full_refund'`, `commitmentStatus = 'closed'`, registra-se o estorno na conta que pagou, e as dívidas bilaterais são zeradas.
3. **Paga com devolução parcial do fornecedor:** `refundStatus = 'partial_refund'`, registra-se a entrada do valor recuperado na conta do pagador original; a diferença não devolvida permanece como despesa de perda efetiva rateada entre os membros.
4. **Paga sem possibilidade de devolução (perda consumada):** `commitmentStatus = 'loss_unrecoverable'`. Como o fornecedor reteve o dinheiro, a despesa financeira ocorreu. **O desembolso do pagador é mantido e as obrigações dos participantes perante o pagador continuam 100% ativas e exigíveis.**
5. **Parcialmente paga e cancelada:** Os pagamentos já feitos ao fornecedor são tratados nos subcasos 2, 3 ou 4; o saldo pendente que não chegou a ser pago é simplesmente anulado.
6. **Cancelamento com adiantamento sob custódia:** O valor que ainda não havia sido repassado ao fornecedor retorna para o status `available` no adiantamento, abrindo o fluxo de decisão entre os envolvidos (devolução bancária ou conversão).

---

# BLOCO D: Fluxos Contábeis e Efeitos por Fonte de Pagamento

| Fonte Utilizada | Efeito na Conta Bancária / Cartão | Efeito no Fundo Coletivo | Efeito nas Responsabilidades dos Membros | Reconhecimento perante o Fornecedor |
| :--- | :--- | :--- | :--- | :--- |
| **Conta Corrente Pessoal** | **Débito imediato** de $R\$$ na conta pessoal do pagador. | Nenhum. | O pagador cobre sua cota e gera **Crédito Bilateral** sobre os membros que não pagaram. | A despesa é baixada no montante pago. |
| **Cartão de Crédito Pessoal** | **Nenhum débito bancário imediato.** Limite do cartão é comprometido e valor entra na fatura aberta. | Nenhum. | O titular do cartão gera **Crédito Bilateral** sobre os demais membros devedores imediatamente. Saída bancária ocorrerá no pagamento da fatura. | A despesa é baixada no montante pago. |
| **Fundo de Reserva Coletivo** | **Nenhum débito pessoal.** Nenhuma conta de participante é alterada. | **Saldo coletivo é debitado** no valor exato pago. | **Nenhum participante contrai dívida individual.** O consumo foi financiado pelo patrimônio comum. | A despesa é baixada no montante pago. |
| **Adiantamento Vinculado** | **Nenhum novo débito.** O dinheiro já havia entrado na conta do custodiante na transferência prévia. | Nenhum. | O custodiante baixa o saldo do adiantamento; o remetente original é reconhecido como o real financiador daquela cota. | A despesa é baixada no montante pago. |

### Mecânica de Resolução de Créditos Bilaterais (Exemplo com 3 Membros e Múltiplos Pagadores)
Fórmula de Cálculo:
1. Para cada membro $i$, sua cota de responsabilidade bruta é $R_i$.
2. Cada membro $i$ desembolsou $P_i$.
3. Saldo Líquido do membro: $S_i = P_i - R_i$.
   - Se $S_i > 0$: Membro é **Credor Líquido** (financiou outrem).
   - Se $S_i < 0$: Membro é **Devedor Líquido** (foi financiado por outrem).
   - Se $S_i = 0$: Membro está perfeitamente equilibrado.
4. O algoritmo determinístico aloca os créditos dos credores líquidos aos devedores líquidos por ordem estável de `uid`, gerando os registros de `BilateralDebtLedger`.

---

# BLOCO E: Segurança, Autorização e Regras Firestore

### E.1. Matriz de Permissões por Ação e Campo

| Entidade / Ação | Participante Comum (Autor) | Responsável pelo Espaço (`ownerId`) | Terceiros / Outros Membros |
| :--- | :--- | :--- | :--- |
| **Criar Despesa / Pagamento** | Permitido (Status fixado em `pending_validation`). | Permitido (Status fixado em `approved`). | Proibido criar em nome de outrem. |
| **Editar Despesa** | Permitido **somente** se status for `pending_validation` ou `rejected`. | **Proibido alterar valores ou rateios.** Pode apenas aprovar/recusar. | Proibido. |
| **Aprovar / Recusar Operação** | Proibido. | **Permitido** (Obrigatório preencher motivo em recusa). | Proibido. |
| **Consultar Contas Bancárias** | Acesso integral às suas próprias contas. | **Visualiza apenas rótulo público** (ex: *"Recurso próprio de Keniel"*). | **Visualiza apenas rótulo público**. |
| **Exclusão de Registros** | **Proibido soft-delete ou hard-delete.** Somente cancelamento formal. | **Proibido apagar dados de terceiros.** Somente cancelamento formal. | Proibido. |
| **Reverter Liquidação** | Pode solicitar reversão com justificativa. | Pode aprovar ou recusar reversão com log. | Proibido. |

### E.2. Exemplo das Regras Firestore Revisadas (Normativas)

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    function isAuthenticated() {
      return request.auth != null;
    }
    
    function isSpaceMember(spaceId) {
      return isAuthenticated() && 
        request.auth.uid in get(/databases/$(database)/documents/spaces/$(spaceId)).data.memberUids;
    }
    
    function isSpaceOwner(spaceId) {
      return isAuthenticated() && 
        request.auth.uid == get(/databases/$(database)/documents/spaces/$(spaceId)).data.ownerId;
    }

    // Regras de Contas Pessoais (Privacidade Absoluta)
    match /accounts/{accountId} {
      allow read, write: if isAuthenticated() && request.auth.uid == resource.data.userId;
      allow create: if isAuthenticated() && request.auth.uid == request.resource.data.userId;
    }

    // Despesas Compartilhadas
    match /shared_expenses/{expenseId} {
      allow read: if isSpaceMember(resource.data.spaceId);
      
      // Criação: membros criam com status pending_validation; dono cria como approved
      allow create: if isSpaceMember(request.resource.data.spaceId) &&
        request.resource.data.createdByUid == request.auth.uid &&
        (
          (isSpaceOwner(request.resource.data.spaceId) && request.resource.data.validationStatus == 'approved') ||
          (!isSpaceOwner(request.resource.data.spaceId) && request.resource.data.validationStatus == 'pending_validation')
        );

      // Atualização:
      // 1. Dono do espaço: PODE alterar APENAS campos de validação (validationStatus, validatedByUid, rejectionReason)
      //    e NÃO PODE alterar valores, descrição, rateios ou autoria.
      // 2. Autor original: PODE corrigir dados APENAS se estiver rejected ou pending_validation.
      allow update: if isSpaceMember(resource.data.spaceId) && (
        (
          isSpaceOwner(resource.data.spaceId) && 
          request.resource.data.totalOriginalAmountCents == resource.data.totalOriginalAmountCents &&
          request.resource.data.createdByUid == resource.data.createdByUid &&
          request.resource.data.diff(resource.data).affectedKeys().hasOnly(['validationStatus', 'validatedByUid', 'validatedAt', 'rejectionReason'])
        ) ||
        (
          resource.data.createdByUid == request.auth.uid &&
          resource.data.validationStatus in ['pending_validation', 'rejected'] &&
          request.resource.data.validationStatus == 'pending_validation' &&
          request.resource.data.createdByUid == resource.data.createdByUid
        )
      );

      allow delete: if false; // Imutabilidade histórica
    }
  }
}
```

---

# BLOCO F: Migração, Quarentena e Conferência Não-Destrutiva

```
┌────────────────────────────────────────────────────────────────────────┐
│                   PIPELINE DE MIGRAÇÃO COM CHECKPOINTS                  │
├─────────────────┬─────────────────┬──────────────────┬─────────────────┤
│     FASE 1      │     FASE 2      │      FASE 3      │     FASE 4      │
│  Classificação  │    Simulação    │ Conferência com  │ Lotes Atômicos  │
│  Estrutural     │   (Dry-Run)     │ Tolerância Zero  │ e Checkpoints   │
└─────────────────┴─────────────────┴──────────────────┴─────────────────┘
```

### F.1. Classificação Baseada em Evidências Estruturais (Sem depender de strings soltas)
1. **Transações Pessoais:** `tx.spaceId === ''` $\rightarrow$ Permanecem intactas em `transactions` original, 100% isoladas.
2. **Reembolsos e Liquidações:** Detectados por `tx.splitShare.length === 0 && tx.recipientEmail !== '' && tx.spaceId !== ''` ou metadados de liquidação $\rightarrow$ Convertidos para `SettlementRecord`.
3. **Receitas de Espaço:**
   - Se `tx.paidByEmail` estiver preenchido e não houver `targetExpenseId`: Classificado como `SharedResourceMovement` (`contribution`).
   - Se houver vínculo com despesa: Classificado como `AdvanceTransfer`.
4. **Despesas de Cartão vs Conta:** Mapeadas pela entidade `accounts` do usuário (`type === 'credit'` vs `'checking'`).
5. **Critério de Quarentena (`unresolved_legacy_transactions`):**
   - Transação compartilhada onde $\sum \text{responsibility} \neq \text{amount}$.
   - Pagamentos atribuídos a e-mails não encontrados em `users`.
   - Transações sem splits definidos criadas antes da padronização.
   - O registro original permanece intacto, visível em tela de conferência para resolução humana.

### F.2. Relatório de Conferência em 13 Dimensões (Tolerância Zero)
Antes de comitar a migração em produção, o script calcula em centavos inteiros:
1. Total de registros processados;
2. Volume total de despesas (R$);
3. Volume total de pagamentos diretos (R$);
4. Volume total de liquidações (R$);
5. Volume total de aportes no fundo (R$);
6. Total de dívidas ativas entre participantes;
7. Saldo líquido de cada participante no espaço ($S_i$);
8. Saldo das contas correntes pessoais;
9. Faturas de cartão de crédito pendentes;
10. Despesas por competência mensal;
11. Registros classificados como quarentena;
12. Soma de centavos de despesas vs soma de cotas individuais;
13. Rastreabilidade 1:1 entre ID antigo e ID novo (`legacyTxId`).

**Regra de Bloqueio:** Se qualquer soma entre o modelo legado e o novo diferir em mais de $R\$\,0,00$, o sistema emite alerta, grava log de diagnóstico e aborta o commit.

### F.3. Execução em Lotes com Checkpoint e Retomada
Para respeitar os limites do Firestore (500 gravações por lote e limite de tempo de transações), a migração opera em lotes de 200 documentos por bloco com a coleção `migration_checkpoints`:
- Se a rede oscilar no lote 5 de 10, o processo grava o último `legacyTxId` processado. Ao reiniciar, o pipeline retoma exatamente de onde parou, sem duplicar dados graças ao `clientTransactionUuid = 'migrated_' + legacyTxId`.

---

# BLOCO G: Demonstração dos 18 Cenários Práticos

Abaixo estão demonstrados todos os 18 cenários, com valores numéricos, contas, débitos, créditos, impactos na visão individual de Keniel e no Espaço compartilhado com Mariana e Carlos.

---

### Cenário 1: Despesa Paga Integralmente por um Participante
*Dados:* Keniel compra R$ 400,00 no supermercado dividida igualmente com Mariana (R$ 200,00 cada). Paga via débito Nubank.
- **Registros:** `SharedExpense` (R$ 400), `ExpenseLiability` (Keniel R$ 200 / Mariana R$ 200), `ExpensePayment` (R$ 400 por Keniel, Nubank, `approved`), `BilateralDebtLedger` (Mariana deve R$ 200 a Keniel).
- **Saldo Individual de Keniel:** Conta Nubank reduz R$ 400,00 imediatamente.
- **Espaço:** Despesa fechada no fornecedor. Mariana deve R$ 200,00 a Keniel.
- **Visão Geral de Keniel:** Saída bancária de R$ 400, compensada por crédito patrimonial de +R$ 200 a receber de Mariana. Gasto real pessoal: R$ 200,00.

---

### Cenário 2: Despesa Paga Parcialmente por Dois Participantes
*Dados:* Conta de água de R$ 300,00 dividida igualmente entre Keniel e Mariana (R$ 150 cada). Keniel paga R$ 200,00 e Mariana paga R$ 100,00 no ato.
- **Registros:** `SharedExpense` (R$ 300), 2 `ExpensePayment` (Keniel R$ 200 / Mariana R$ 100), `BilateralDebtLedger` (Mariana deve R$ 50 a Keniel).
- **Saldo Individual:** Conta de Keniel -R$ 200; conta de Mariana -R$ 100.
- **Espaço:** Despesa 100% quitada no fornecedor. Mariana deve R$ 50,00 a Keniel (pois Keniel financiou R$ 50 da responsabilidade de Mariana).

---

### Cenário 3: Transferência para Terceiro Pagar Conta (Adiantamento Vinculado)
*Dados:* Mariana transfere R$ 300,00 via PIX para Keniel pagar o aluguel no dia seguinte.
- **Registros:** `AdvanceTransfer` (R$ 300, sender: Mariana, receiver: Keniel, `targetExpenseId: aluguel`), `AdvanceEvent` (`transfer_in`).
- **Saldo Individual de Keniel:** Conta bancária aumenta R$ 300,00, mas com passivo em custódia correspondente (sem alterar seu patrimônio líquido e sem constar como receita pessoal).
- **Espaço:** A despesa do aluguel continua como `unpaid` até que Keniel efetue o pagamento ao proprietário.

---

### Cenário 4: Contribuição para Recursos Livres (Fundo de Reserva Coletivo)
*Dados:* Keniel aporta R$ 250,00 de sua conta pessoal no Fundo de Reserva do Espaço.
- **Registros:** `ResourceMovementEvent` (`contribution`, R$ 250, author: Keniel), `SharedResourcePool` atualiza saldo para R$ 250,00.
- **Saldo Individual de Keniel:** Saída bancária de R$ 250,00.
- **Espaço:** O fundo passa a ter R$ 250,00 disponíveis. Não gera dívida individual para Mariana, pois o fundo é patrimônio coletivo indivisível.

---

### Cenário 5: Pagamento de Despesa com Recursos Compartilhados Livres
*Dados:* Compra de lâmpadas de R$ 80,00 paga com o Fundo de Reserva Livre (saldo anterior: R$ 250,00).
- **Registros:** `SharedExpense` (R$ 80,00), `ExpensePayment` (R$ 80,00, fonte: `free_shared_pool`), `ResourceMovementEvent` (`expense_payment`).
- **Saldo Individual:** Nenhuma conta bancária de participante é alterada.
- **Espaço:** Saldo do Fundo de Reserva cai de R$ 250,00 para R$ 170,00. A despesa fica quitada perante o comércio e nenhum participante fica devendo nada aos demais.

---

### Cenário 6: Despesa Cancelada Após Pagamento
*Dados:* Keniel pagou R$ 600,00 em um serviço (R$ 300 Keniel / R$ 300 Mariana). O serviço foi cancelado.
- **Subcaso A (Devolução Total do Fornecedor):** R$ 600 entram na conta de Keniel. `SharedExpense` vai para `refundStatus: full_refund`. Mariana não deve nada a Keniel.
- **Subcaso B (Sem Devolução / Perda Inegociável):** Fornecedor reteve o valor. `SharedExpense` vai para `commitmentStatus: loss_unrecoverable`. A despesa efetiva ocorreu; **Mariana continua obrigada a pagar R$ 300 a Keniel**, garantindo que o pagador não arque sozinho com o golpe ou perda.

---

### Cenário 7: Liquidação de Saldo entre Participantes (FIFO por Par)
*Dados:* Mariana deve a Keniel R$ 70,00 (outubro) e R$ 80,00 (novembro). Mariana faz PIX de R$ 100,00 para Keniel.
- **Registros:** `SettlementRecord` (R$ 100, devedor: Mariana, credor: Keniel), `SettlementAllocation 1` (R$ 70 na dívida de outubro - quitando-a), `SettlementAllocation 2` (R$ 30 na dívida de novembro - restando R$ 50).
- **Espaço:** Dívida bilateral total de Mariana com Keniel cai de R$ 150 para R$ 50. Não altera despesas de consumo do grupo nem infla receitas pessoais.

---

### Cenário 8: Fatura de Cartão Paga Parcialmente e Transportada
*Dados:* Fatura com R$ 1.000,00 de despesas compartilhadas. Keniel paga R$ 600,00 e transporta R$ 400,00 para a fatura seguinte.
- **Registros:** Saída bancária de R$ 600,00 na conta de Keniel; `InvoiceCarryOver` de R$ 400,00 gerado para o próximo mês; encargos e juros são calculados separadamente. Mariana segue devendo apenas sua cota de compras original, a menos que o atraso tenha sido acordado como compartilhado.

---

### Cenário 9: Compra Parcelada Compartilhada
*Dados:* Máquina de lavar de R$ 3.000,00 em 3x de R$ 1.000,00 no cartão de Keniel, dividida igualmente (R$ 500/mês para Mariana).
- **Registros:** `InstallmentPurchase` (R$ 3.000, 3 parcelas). Cada mês recebe uma ocorrência de R$ 1.000 vinculada à fatura correspondente. Mariana assume a obrigação de R$ 500 mês a mês, sem sobrecarregar a competência atual.

---

### Cenário 10: Operação Criada por Participante Aguardando Validação
*Dados:* Mariana cadastra despesa de R$ 180,00 afirmando ter pago em dinheiro.
- **Registros:** `SharedExpense` e `ExpensePayment` com `validationStatus = 'pending_validation'`.
- **Saldo Oficial Conciliado:** Rigorosamente inalterado. Nenhuma dívida é computada no saldo oficial.
- **Interface:** Exibe alerta de Saldo Projetado. Keniel recebe card para aprovar ou recusar (com motivo obrigatório).

---

### Cenário 11: Despesa com Três Participantes e Múltiplos Pagadores
*Dados:* Aluguel de temporada de R$ 900,00 dividido igualmente entre Keniel, Mariana e Carlos (R$ 300,00 cada).
- **Pagamentos Efetuados:** Keniel paga R$ 500,00; Mariana paga R$ 400,00; Carlos paga R$ 0,00.
- **Cálculo de Saldos Líquidos:**
  - Keniel: Cota R$ 300, pagou R$ 500 $\rightarrow$ **Credor Líquido de +R$ 200,00**.
  - Mariana: Cota R$ 300, pagou R$ 400 $\rightarrow$ **Credor Líquido de +R$ 100,00**.
  - Carlos: Cota R$ 300, pagou R$ 0 $\rightarrow$ **Devedor Líquido de -R$ 300,00**.
- **Registros Bilaterais Gerados no `BilateralDebtLedger`:**
  - `BilateralDebt 1`: Carlos deve **R$ 200,00 para Keniel**.
  - `BilateralDebt 2`: Carlos deve **R$ 100,00 para Mariana**.
  - Relação Keniel $\leftrightarrow$ Mariana: **R$ 0,00** (ambos cobriram suas cotas e não devem nada entre si).
- **Auditoria:** Despesa 100% quitada no fornecedor; o déficit de Carlos foi coberto na proporção exata do excesso desembolsado por Keniel e Mariana.

---

### Cenário 12: Adiantamento Parcialmente Utilizado e Devolvido
*Dados:* Mariana transfere R$ 300,00 para Keniel para uma compra. Keniel gasta R$ 180,00 e devolve R$ 120,00 via PIX para Mariana.
- **Passo 1 (Transferência):** `AdvanceTransfer` (R$ 300), saldo disponível R$ 300.
- **Passo 2 (Uso):** Compra de R$ 180 registrada com `fundingSource: advance_transfer`. `AdvanceEvent` (`usage`, R$ 180). Saldo do adiantamento cai para R$ 120. A compra não gera novo débito bancário para Keniel.
- **Passo 3 (Devolução):** Keniel faz PIX de R$ 120 para Mariana. `AdvanceEvent` (`return`, R$ 120). Saldo do adiantamento vai a **R$ 0,00** (`status: exhausted`). Conta de Keniel debita R$ 120 e conta de Mariana credita R$ 120. Rastreabilidade 100% fechada.

---

### Cenário 13: Fundo Coletivo Utilizado sem Cobranças Duplicadas
*Dados:* Keniel aporta R$ 250,00 no Fundo Coletivo. Depois, o Espaço gasta R$ 80,00 com materiais gerais usando o fundo.
- **Aporte:** Keniel debita R$ 250 de sua conta; o Fundo Coletivo registra saldo de R$ 250.
- **Despesa:** Despesa de R$ 80 é registrada com categoria "Materiais" para fins de competência e relatório de consumo. O pagamento é associado à fonte `free_shared_pool`.
- **Saldo do Fundo:** Reduzido de R$ 250 para R$ 170.
- **Prevenção de Cobrança Duplicada:** O motor contábil reconhece que a despesa foi financiada pelo Fundo Comum e **não gera registros em `BilateralDebtLedger`**. Mariana não contrai dívida e Keniel não recebe crédito adicional, pois o fundo coletivo já pertencia indivisivelmente ao espaço.

---

### Cenário 14: Despesa Cancelada com Devolução Parcial pelo Fornecedor
*Dados:* Compra compartilhada de R$ 600,00 (Keniel R$ 300 / Mariana R$ 300), paga por Keniel via Nubank. O fornecedor cancelou e devolveu apenas R$ 400,00 na conta de Keniel (retenção de R$ 200,00 de multa contratual inegociável).
- **Passo 1:** Entrada de R$ 400,00 na conta Nubank de Keniel registrada como estorno (`refund_events`).
- **Passo 2:** A `SharedExpense` tem seu valor líquido ajustado para R$ 200,00 (a perda real consumada).
- **Passo 3:** As responsabilidades brutas em `ExpenseLiability` são recalculadas: Keniel R$ 100,00 e Mariana R$ 100,00.
- **Passo 4:** Em `BilateralDebtLedger`, a dívida de Mariana com Keniel é atualizada de R$ 300,00 para **R$ 100,00**.
- **Resultado:** Keniel desembolsou R$ 600, recebeu R$ 400 de volta (saldo líquido desembolsado: R$ 200). Recebe R$ 100 de Mariana e arca com R$ 100. Perda dividida com justiça e exatidão.

---

### Cenário 15: Liquidação Revertida (Estorno de Acerto de Contas)
*Dados:* Mariana registrou liquidação de R$ 100,00 para Keniel abatendo dívidas passadas. Descobriu-se que o PIX falhou no banco e a liquidação precisa ser desfeita.
- **Passo 1:** A liquidação original `SettlementRecord` NÃO é apagada. Seu status passa para `reverted`, com data, autor e justificativa (*"PIX estornado pela instituição financeira por instabilidade"*).
- **Passo 2:** As alocações em `SettlementAllocation` são invalidadas atomicamente.
- **Passo 3:** As obrigações correspondentes em `BilateralDebtLedger` recuperam seus saldos devedores anteriores em exatos R$ 100,00.
- **Auditoria:** O histórico preserva tanto a tentativa de liquidação quanto sua reversão, garantindo conformidade contábil.

---

### Cenário 16: Compra Parcelada Compartilhada com Cancelamento Futuro
*Dados:* Compra de R$ 3.000,00 em 3x de R$ 1.000,00 (R$ 500/mês para Mariana). Após a 1ª parcela ser paga, o serviço é rescindido e as parcelas 2 e 3 são canceladas na operadora do cartão.
- **Parcela 1 (Paga):** Permanece 100% íntegra no histórico. Mariana deve R$ 500 referentes ao mês consumido.
- **Parcelas 2 e 3 (Futuras):** O contrato `InstallmentPurchase` tem o status alterado para `cancelled` a partir da parcela 2. As despesas projetadas para os meses seguintes são marcadas como `cancelled_pre_payment`.
- **Resultado:** Mariana não deve nada nos meses futuros e a fatura do cartão não é impactada, sem deixar lançamentos órfãos.

---

### Cenário 17: Operação Pendente Recusada, Corrigida e Reenviada
*Dados:* Mariana cadastra uma despesa de R$ 250,00 de manutenção.
- **Passo 1:** Registro entra com `validationStatus: pending_validation`. Saldo oficial conciliado permanece inalterado.
- **Passo 2:** Keniel analisa o comprovante físico e vê que o valor real era R$ 200,00. Keniel clica em "Recusar" e informa o motivo: *"Nota fiscal anexada é de R$ 200,00 e não R$ 250,00"*. Status vai para `rejected`.
- **Passo 3:** Mariana recebe notificação com a justificativa. Ela clica em "Corrigir Registro", altera o valor para R$ 200,00 e reenvia.
- **Passo 4:** Status retorna para `pending_validation`. Keniel confere o novo valor e clica em "Aprovar". O status vai para `approved` e o débito bilateral entra no saldo oficial.
- **Auditoria:** O log de auditoria registrou a criação original, a recusa com justificativa, a alteração de valor e a aprovação final.

---

### Cenário 18: Pagamento Misto: Adiantamento Vinculado + Recurso Próprio
*Dados:* Keniel possui R$ 200,00 de adiantamento recebido de Mariana vinculado à conta de energia de R$ 350,00. A despesa veio no valor de R$ 350,00 (dividida 50/50: R$ 175 cada). Keniel paga integralmente ao fornecedor usando os R$ 200 de adiantamento + R$ 150 de sua conta corrente pessoal Nubank.
- **Registros:**
  - `SharedExpense`: R$ 350,00 (Quitada no fornecedor).
  - `ExpensePayment 1`: R$ 200,00 com fonte `advance_transfer` (consome os R$ 200 de Mariana).
  - `ExpensePayment 2`: R$ 150,00 com fonte `personal_checking` (debita R$ 150 do Nubank de Keniel).
- **Cálculo da Obrigação Final:**
  - Responsabilidade de Mariana: R$ 175,00. Mariana já havia adiantado R$ 200,00. Portanto, Mariana pagou R$ 25,00 a mais do que sua responsabilidade.
  - Responsabilidade de Keniel: R$ 175,00. Keniel desembolsou R$ 150,00 do bolso (pois usou R$ 200 de Mariana). Keniel desembolsou R$ 25,00 a menos do que sua cota.
- **Resultado em `BilateralDebtLedger`:** **Keniel deve R$ 25,00 para Mariana!**
- **Auditoria:** A matemática fecha com exatidão implacável. O adiantamento cobriu a cota de Mariana e ainda sobrou R$ 25 de crédito em favor dela perante Keniel.

---

# BLOCO H: Pendências Reais e Decisões Estritamente Necessárias

Conforme a sua instrução, **nenhuma das 4 decisões anteriores foi reaberta** (alçada 100%, quarentena por tempo indeterminado, privacidade das contas e fundo de reserva coletivo estão integralmente incorporados).

As únicas pendências restantes referem-se à experiência de interface do usuário durante a resolução da quarentena:

1. **Notificação de Operações Pendentes:** O responsável prefere receber alertas visuais destacados no cabeçalho do aplicativo ao entrar no espaço, ou prefere uma aba dedicada chamada "Central de Validações"?
2. **Interface de Quarentena da Migração:** Na tela de conferência de dados legados ambíguos, aprova a exibição em tabela lado a lado comparando os campos originais do documento e permitindo selecionar a ação (ex: *"Confirmar como Despesa"*, *"Confirmar como Reembolso"* ou *"Manter em Quarentena"*)?

---

# BLOCO I: Riscos Residuais e Plano de Mitigação Prévia

| Risco Técnico Identificado | Probabilidade / Impacto | Medida de Mitigação Projetada na Arquitetura |
| :--- | :--- | :--- |
| **Volume de Leituras no Firestore por Subcoleções** | Média / Baixo custo | Uso de denormalização dos campos essenciais (`totalPaidAmountCents`, `validationStatus`) no documento pai `SharedExpense`, evitando ler as subcoleções em listagens simples. |
| **Instabilidade de Rede durante Pagamentos Compostos** | Baixa / Alto impacto | Adoção do `clientTransactionUuid` com verificação de idempotência em `runTransaction`, impedindo execuções parciais ou cobranças duplicadas. |
| **Complexidade de Conciliação em Registros Legados Mutilados** | Alta / Médio impacto | Isolamento total na coleção `unresolved_legacy_transactions`, garantindo que registros corrompidos não quebrem o motor novo. |

---

# Conclusão e Próximo Passo

Esta Especificação Arquitetural e Contábil Definitiva (v3.0) consolida todas as exigências técnicas, contábeis e de segurança, eliminando as premissas frágeis das versões anteriores e garantindo harmonia absoluta entre o patrimônio individual e o controle coletivo dos Espaços.

O documento oficial completo está preservado no artefato **`especificacao_arquitetura_financeira_definitiva_v3.md`**.

Reiterando: **nenhum código de produção foi alterado nesta etapa.** 

Aguardamos sua validação final deste documento normativo para que, somente mediante sua ordem expressa, possamos estruturar o cronograma de implementação faseado.
