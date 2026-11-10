# Especificação Arquitetural e Contábil Definitiva (Versão 4.0)
## Sistema Financeiro de Espaços Compartilhados e Finanças Pessoais Integradas

**Documento Oficial de Engenharia de Software, Contabilidade Analítica e Segurança de Dados**  
**Status do Documento:** Revisão Técnica Final para Homologação do Usuário  
**Autorização de Implementação:** NÃO AUTORIZADA (Documento Estritamente Normativo e Conceitual)  
**Data:** 09 de Novembro de 2026  
**Auditoria de Código-Fonte:** `src/types/finance.ts`, `src/utils/financeEngine.ts`, `src/App.tsx`, `src/components/UniversalTransactionModal.tsx`, `src/components/acquisitions/AcquisitionsModuleView.tsx`.

---

# SEÇÃO 1: Matriz de Revisões Críticas (Da v3.0 para a v4.0)

| Eixo / Problema Apontado | Como Estava na v3.0 | Qual Era o Problema Técnico / Contábil | Como Ficou na v4.0 (Solução Definitiva) | Por que a Solução Resolve | Entidades e Processos Afetados |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Alçada de Aprovação e Autoaprovação** | Responsável criava operações já como `approved`. | Violava a regra de aprovação universal (100%). O gestor podia se autoaprovar sem crivo dos pares. | **Eliminação total da autoaprovação.** Operações criadas pelo responsável exigem aprovação de outro membro ativo (validação cruzada bilateral). Em espaços de 2 pessoas, há consenso recíproco obrigatório. | Ninguém aprova os próprios atos financeiros; governança 100% auditável. | `SharedExpense`, `ExpensePayment`, `SettlementRecord`, `AdvanceTransfer`, `ResourceMovementEvent`. |
| **2. Separação Executor vs. Financiador Econômico** | `ExpensePayment` continha apenas `paidByUid`. | Em adiantamentos e pagamentos mistos (Cenário 18), não distinguia quem entregou o dinheiro ao fornecedor de quem era o dono original do recurso. | Criação dos papéis explícitos: `executedByUid` (executor físico/operacional) e `economicFunderUid` (financiador econômico real). | Permite rastrear a origem real do capital sem distorcer dívidas e créditos bilaterais. | `ExpensePayment`, `BilateralDebtLedger`. |
| **3. Despesas Parcialmente Pagas** | A fórmula $S_i = P_i - R_i$ transformava déficits automaticamente em dívidas bilaterais entre os membros. | Se a despesa de R$ 400 teve apenas R$ 100 pagos, o restante (R$ 300) é passivo perante o **fornecedor externo**, e não dívida bilateral entre os participantes. | Separação formal em 3 grandezas: (1) Passivo residual com fornecedor (`supplierUnpaidBalanceCents`); (2) Cobertura da cota própria; (3) Financiamento excedente de terceiros (`BilateralDebtLedger`). | Impede a criação prematura de dívidas entre membros antes que o fornecedor seja pago. | `SharedExpense`, `ExpenseLiability`, `BilateralDebtLedger`. |
| **4. Privacidade Bancária no Firestore** | Campos de conta (`privateAccountId`) ficavam no mesmo documento compartilhado. | No Firestore, regras de segurança protegem **documentos inteiros**, não campos. Participantes com acesso de leitura leriam os IDs bancários privados. | **Arquitetura de Segregação Documental:** Os dados bancários residem em subcoleções privadas (`accounts/{accountId}/private_transactions` ou `private_payment_metadata/{paymentId}`), acessíveis estritamente pelo titular (`request.auth.uid == userId`). O documento compartilhado contém apenas o rótulo público `publicPayerLabel`. | Blindagem de nível de banco; impossível vazar contas por inspeção de rede ou SDK. | `accounts`, `ExpensePayment`, `SettlementRecord`, `firestore.rules`. |
| **5. Imutabilidade e Histórico de Reversões** | Reversões e reembolsos recalculavam e sobrescreviam valores em `BilateralDebtLedger` e `SharedExpense`. | Destruía a auditabilidade temporal; impedia reconstruir o balanço de uma data passada. | **Padrão Contábil Event-Sourced:** O registro de origem é estritamente imutável. Ajustes, reembolsos e reversões são gravados como eventos próprios (`RefundEvent`, `SettlementReversionEvent`, `AdjustmentEvent`). O `BilateralDebtLedger` passa a ser uma visão projetada determinística. | Permite reconstruir o balanço de qualquer momento histórico e auditar todas as ações. | Todas as entidades financeiras e subcoleções de eventos. |
| **6. Fundo de Reserva como Saldo Contábil Coletivo** | Tratado genericamente como "patrimônio coletivo", gerando dúvidas sobre titularidade jurídica. | O espaço não tem CNPJ ou personalidade jurídica. Precisava de definição contábil precisa para dissolução e encerramento. | Definido como **Saldo Contábil de Recursos Livres Custodiados**. Registra o histórico de aportes e baixas sem cotas individuais ativas. Em caso de dissolução ou saída de membro, a destinação é decidida por deliberação unânime formal. | Clareza contábil sem conflitos jurídicos ou ficções financeiras. | `SharedResourcePool`, `ResourceMovementEvent`. |
| **7. Limites de Lotes na Migração** | Lote fixo de 200 transações assumindo margem do limite de 500 escritas do Firestore. | Uma única transação legada com splits pode gerar 1 despesa + N responsabilidades + 1 pagamento + débitos bilaterais (5 a 8 escritas), estourando os 500 do lote. | **Dimensionamento Dinâmico de Lote:** O pipeline calcula a soma estimada de escritas derivadas ($W = \sum \text{docs\_derivados}$) e fecha o lote quando $W \le 400$, garantindo margem de segurança absoluta com checkpoints atômicos. | Impossibilita erros de limite de batch do Firestore e garante commits 100% seguros. | `MigrationEngine`, `unresolved_legacy_transactions`. |

---

# SEÇÃO 2: Decisões de Negócio Consolidadas (Inalteráveis)

1. **Alçada de Aprovação de 100% (Sem Autoaprovação):**
   - Nenhuma operação financeira gera efeitos no saldo oficial sem aprovação de um terceiro autorizado.
   - Operações criadas pelo responsável do espaço devem ser aprovadas por outro participante ativo (validação cruzada).
   - Em espaços com apenas 2 participantes (ex: Keniel e Mariana), vigora o **Consenso Bilateral**: toda operação criada por Keniel deve ser aprovada por Mariana, e vice-versa.
   - Nenhuma interface ou chamada de API permite que o autor aprove sua própria operação.
2. **Quarentena da Migração Permanente até Resolução Manual:**
   - Registros ambíguos não sofrem exclusão por tempo, nem conversão forçada por heurística frágil.
   - Interface de quarentena dedicada exibe os dados lado a lado com a opção padrão **"Manter em Quarentena"**.
3. **Privacidade Absoluta de Contas Bancárias:**
   - O grupo visualiza apenas rótulos abstratos: *"Recurso próprio de Keniel"*, *"Recurso próprio de Mariana"* ou *"Fundo de Reserva"*.
   - A conta bancária, agência, banco e comprovantes bancários privados ficam fisicamente isolados em coleções protegidas por Firestore Rules.
4. **Fundo de Reserva Coletivo Indivisível:**
   - O fundo é um saldo contábil livre. Seu uso quita a despesa perante terceiros sem gerar dívidas entre os participantes. Aporte e utilização são eventos distintos.

---

# SEÇÃO 3: Matriz de Validação Universal de Todas as Operações

Toda e qualquer mutação patrimonial no Espaço segue o ciclo de validação:

| Operação Financeira | Solicitante Permitido | Executor Financeiro | Aprovador Obrigatório | Estado Inicial | Efeito no Saldo Projetado | Efeito no Saldo Oficial | Tratamento em Caso de Recusa | Regra de Reversão Pós-Aprovação |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Criar Despesa com Pagamento Direto** | Qualquer membro do espaço | Membro pagador | Outro membro ativo (Consenso / Validação Cruzada) | `pending_validation` | Exibe despesa e cota projetada sob aviso visual | **Zero efeito.** Dívidas bilaterais não existem oficialmente | Autor é notificado com justificativa; pode editar e reenviar | Exige evento formal de cancelamento ou estorno com aprovação cruzada |
| **Aporte no Fundo de Reserva** | Membro que aporta | Membro que aporta | Outro membro ativo | `pending_validation` | Exibe fundo projetado com acréscimo | **Zero efeito.** Fundo oficial permanece inalterado | Operação é descartada ou corrigida pelo autor | Exige solicitação de retirada autorizada |
| **Pagamento de Despesa com Fundo de Reserva** | Qualquer membro do espaço | Fundo Coletivo | Responsável ou outro membro ativo (diferente do autor) | `pending_validation` | Exibe reserva deduzida e despesa coberta | **Zero efeito.** Saldo do fundo não é baixado | Despesa permanece em aberto no fornecedor | Exige evento de estorno de uso do fundo (`ResourceMovementEvent`) |
| **Adiantamento / Transferência Vinculada** | Remetente do dinheiro | Remetente | Destinatário (Custodiante do valor) | `pending_validation` | Exibe adiantamento em trânsito | **Zero efeito.** Destinatário não é custodiante oficial | Notifica remetente; dinheiro deve ser devolvido externamente | Exige evento de devolução registrado em `advance_events` |
| **Utilização de Adiantamento em Despesa** | Custodiante do adiantamento | Custodiante | Remetente original do adiantamento | `pending_validation` | Exibe adiantamento consumido na projeção | **Zero efeito.** O adiantamento permanece como saldo disponível | Despesa volta ao estado de pendente de pagamento | Reversão de uso do adiantamento via evento imutável |
| **Liquidação Bilateral (Acerto de Contas)** | Devedor que realizou o pagamento | Devedor | Credor que recebeu o dinheiro | `pending_validation` | Exibe dívida como quitada na projeção | **Zero efeito.** Dívida bilateral oficial continua ativa | Devedor recebe motivo (ex: *"PIX não caiu"*); reenvia comprovante | Exige `SettlementReversionEvent` aprovado por ambas as partes |
| **Cancelamento de Despesa** | Autor da despesa ou gestor | N/A | Todos os membros envolvidos no rateio | `pending_cancellation` | Exibe impacto do cancelamento na projeção | **Zero efeito.** Obrigações originais continuam vigentes | Despesa permanece ativa | Se houver desembolso consumado, abre fluxo de rateio de perda ou estorno |

---

# SEÇÃO 4: Modelo de Dados Definitivo e Topologia Segura Firestore

### 4.1. Arquitetura de Isolamento de Dados Públicos vs. Privados

```
FIRESTORE ROOT
├── users/ {uid}                                             [Público para membros autenticados]
├── accounts/ {accountId}                                    [Privado: request.auth.uid == resource.data.userId]
│    └── private_payment_metadata/ {paymentId}               [Privado: dados bancários reais, agência, conta, comprovante]
├── spaces/ {spaceId}                                        [Compartilhado entre membros do espaço]
│    ├── resource_pool/ default                              [Saldo contábil coletivo]
│    │    └── movements/ {movementId}                        [Aportes e baixas do fundo]
│    └── audit_log/ {logId}                                  [Trilha imutável de auditoria]
├── shared_expenses/ {expenseId}                             [Compartilhado: dados públicos da despesa]
│    ├── liabilities/ {liabilityId}                          [Responsabilidade bruta de cada participante]
│    ├── payments/ {paymentId}                               [Pagamentos públicos: publicPayerLabel, executedByUid, economicFunderUid]
│    ├── bilateral_debts/ {debtId}                           [Visão projetada de créditos bilaterais constituídos]
│    └── refund_events/ {refundId}                           [Estornos do fornecedor ou perdas contratuais]
├── advance_transfers/ {advanceId}                           [Compartilhado: controle de custódia]
│    └── events/ {eventId}                                   [Histórico imutável de movimentações do adiantamento]
├── settlement_records/ {settlementId}                       [Compartilhado: liquidação entre pares]
│    ├── allocations/ {allocationId}                         [Vínculo FIFO com dívidas bilaterais]
│    └── reversions/ {reversionId}                           [Histórico de reversões de liquidação]
├── credit_card_invoices/ {invoiceId}                        [Privado do titular do cartão]
│    ├── carry_overs/ {carryId}                              [Saldos rolados de faturas vencidas]
│    └── installment_plans/ {planId}                         [Financiamento de fatura]
├── recurring_patterns/ {patternId}                          [Modelos de recorrência do espaço]
├── unresolved_legacy_transactions/ {legacyTxId}             [Quarentena permanente da migração]
└── idempotency_keys/ {clientTransactionUuid}                [Chaves de proteção contra duplicações]
```

### 4.2. Dicionário de Tipos e Interfaces TypeScript

```typescript
// ============================================================================
// 1. DESPESA COMPARTILHADA (A OBRIGAÇÃO)
// ============================================================================
export type ValidationStatus = 
  | 'pending_validation'  // Aguarda aprovação do par/gestor
  | 'approved'            // Aprovada pelo par/gestor (nunca autoaprovada)
  | 'rejected'            // Recusada com justificativa
  | 'cancelled';          // Cancelada formalmente

export type CommitmentStatus = 
  | 'active'              // Despesa válida em curso
  | 'closed'              // Totalmente liquidada no fornecedor e entre membros
  | 'cancelled_pre_payment' // Cancelada antes de qualquer desembolso
  | 'loss_unrecoverable'; // Cancelada no fornecedor sem reembolso (perda ativa)

export type PaymentExecutionStatus = 
  | 'unpaid'              // Nada pago ao fornecedor
  | 'partially_paid'      // Pago parcialmente ao fornecedor
  | 'fully_paid';         // Totalmente pago ao fornecedor

export interface SharedExpense {
  id: string;
  spaceId: string;
  title: string;
  description?: string;
  totalOriginalAmountCents: number; // Centavos inteiros
  competenceMonth: string;          // YYYY-MM
  competenceDate: string;           // YYYY-MM-DD
  dueDate?: string;                 // YYYY-MM-DD
  categoryId: string;
  categoryName: string;
  
  // Estados Ortogonais
  validationStatus: ValidationStatus;
  commitmentStatus: CommitmentStatus;
  paymentExecutionStatus: PaymentExecutionStatus;
  
  // Governança e Auditoria
  createdByUid: string;
  createdByName: string;
  createdAt: string;
  validatedByUid?: string;          // Obrigatório: quem validou (DEVE ser diferente de createdByUid)
  validatedByName?: string;
  validatedAt?: string;
  rejectionReason?: string;
  clientTransactionUuid: string;    // Idempotência

  // Valores Computados a partir de Payments 'approved'
  totalPaidToSupplierCents: number; // Quanto o fornecedor já recebeu
  supplierUnpaidBalanceCents: number; // totalOriginalAmountCents - totalPaidToSupplierCents
}

// ============================================================================
// 2. RESPONSABILIDADE FINANCEIRA BRUTA (CADA PARTICIPANTE)
// ============================================================================
export interface ExpenseLiability {
  id: string;                       // expenseId + '_' + memberUid
  expenseId: string;
  spaceId: string;
  memberUid: string;
  memberName: string;
  assignedShareAmountCents: number; // Cota bruta do membro nesta despesa
  adjustedShareAmountCents: number; // Cota líquida pós-estornos ou perdas
  splitMethod: 'equal' | 'percentage' | 'custom_value';
  splitRatio?: number;
  roundingRemainderRank?: number;   // Posição no algoritmo Hamilton/Hare
}

// ============================================================================
// 3. PAGAMENTO DA DESPESA (DESEMBOLSO PÚBLICO + METADADOS PRIVADOS)
// ============================================================================
export type PaymentFundingSourceType = 
  | 'personal_checking'             // Conta bancária própria
  | 'credit_card'                   // Cartão de crédito
  | 'free_shared_pool'              // Fundo de Reserva Livre
  | 'advance_transfer';             // Adiantamento vinculado

export interface ExpensePayment {
  id: string;
  expenseId: string;
  spaceId: string;
  amountCents: number;
  paymentDate: string;
  
  // Papéis Fundamentais Desacoplados
  executedByUid: string;            // Quem entregou o dinheiro ao fornecedor
  executedByName: string;
  economicFunderUid: string;        // De quem era o recurso original (ex: Mariana no adiantamento)
  economicFunderName: string;
  
  fundingSource: PaymentFundingSourceType;
  publicPayerLabel: string;         // Ex: "Recurso próprio de Keniel" (PÚBLICO)
  advanceTransferId?: string;       // Se adiantamento
  
  // Validação Cruzada Obrigatória
  validationStatus: ValidationStatus;
  validatedByUid?: string;          // DEVE ser != executedByUid e != economicFunderUid
  validatedByName?: string;
  validatedAt?: string;
  rejectionReason?: string;
  clientTransactionUuid: string;
  createdAt: string;
}

// Metadados Privados do Pagamento (Acessível SOMENTE pelo titular em accounts/{accountId}/...)
export interface PrivatePaymentMetadata {
  paymentId: string;
  userId: string;
  accountId: string;
  bankName: string;
  accountType: 'checking' | 'credit';
  transactionProofUrl?: string;     // URL do comprovante protegida
  realBankDebitTimestamp: string;
}

// ============================================================================
// 4. CRÉDITOS E DÉBITOS BILATERAIS (VISÃO PROJETADA PROVADA POR EVENTOS)
// ============================================================================
export interface BilateralDebtLedger {
  id: string;                       // expenseId + '_' + debtorUid + '_' + creditorUid
  expenseId: string;
  spaceId: string;
  competenceMonth: string;
  debtorUid: string;                // Membro que teve sua responsabilidade financiada
  debtorName: string;
  creditorUid: string;              // Membro que financiou a cota de outrem
  creditorName: string;
  originalFinancedAmountCents: number; // Montante original do crédito bilateral
  liquidatedCents: number;          // Amortizado via SettlementRecord
  adjustedLossCents: number;        // Ajustes por perda ou cancelamento parcial
  currentRemainingDebtCents: number;// originalFinancedAmountCents - (liquidatedCents + adjustedLossCents)
  status: 'open' | 'partially_settled' | 'fully_settled';
  updatedAt: string;
}

// ============================================================================
// 5. ADIANTAMENTOS E EVENTOS DE CUSTÓDIA
// ============================================================================
export interface AdvanceTransfer {
  id: string;
  spaceId: string;
  senderUid: string;
  senderName: string;
  custodianUid: string;             // Quem está com o dinheiro em conta
  custodianName: string;
  initialAmountCents: number;
  availableBalanceCents: number;    // Saldo ainda não consumido
  targetExpenseId?: string;         // Despesa carimbada (opcional)
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
  justification?: string;
  executedByUid: string;
  clientTransactionUuid: string;
  createdAt: string;
}

// ============================================================================
// 6. FUNDO DE RESERVA LIVRE (SALDO CONTÁBIL COLETIVO)
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
  validatedByUid?: string;          // DEVE ser != authorUid
  clientTransactionUuid: string;
  createdAt: string;
}

// ============================================================================
// 7. LIQUIDAÇÃO BILATERAL E REVERSÃO HISTÓRICA
// ============================================================================
export interface SettlementRecord {
  id: string;
  spaceId: string;
  debtorUid: string;
  debtorName: string;
  creditorUid: string;
  creditorName: string;
  totalSettledAmountCents: number;
  date: string;
  validationStatus: ValidationStatus;
  validatedByUid?: string;          // DEVE ser o creditorUid
  status: 'completed' | 'reverted';
  clientTransactionUuid: string;
  createdAt: string;
}

export interface SettlementAllocation {
  id: string;
  settlementId: string;
  bilateralDebtId: string;          // ID em BilateralDebtLedger
  expenseId: string;
  competenceMonth: string;
  amountAllocatedCents: number;     // Valor abatido desta obrigação específica (FIFO)
}

export interface SettlementReversionEvent {
  id: string;
  settlementId: string;
  spaceId: string;
  requestedByUid: string;
  approvedByUid: string;            // Consenso da outra parte
  revertReason: string;
  revertedAt: string;
  clientTransactionUuid: string;
}

// ============================================================================
// 8. EVENTOS DE ESTORNO E CANCELAMENTO DE DESPESA
// ============================================================================
export interface ExpenseRefundEvent {
  id: string;
  expenseId: string;
  spaceId: string;
  refundType: 'full_refund' | 'partial_refund' | 'unrecoverable_loss';
  amountRefundedCents: number;      // Quanto o fornecedor devolveu
  lossAmountCents: number;          // Quanto foi retido como prejuízo
  recipientUid: string;             // Quem recebeu a devolução bancária
  date: string;
  validationStatus: ValidationStatus;
  validatedByUid?: string;
  justification: string;
  createdAt: string;
}
```

---

# SEÇÃO 5: Motor Contábil de Despesas Parcialmente Pagas e Múltiplos Pagadores

### 5.1. Regras Matemáticas Rigorosas

Dada uma despesa com valor total $V$ e participantes $i \in \{1, \dots, n\}$ com responsabilidades individuais $R_i$ (onde $\sum_{i=1}^n R_i = V$).  
Considere que foram reconhecidos pagamentos aprovados ao fornecedor no montante total $P_{\text{total}} = \sum_{j} P_j$, onde cada pagamento foi financiado economicamente pelo participante $k$ no valor $P_{k}^{\text{funded}}$.

1. **Saldo Pendente Perante o Fornecedor Externo:**
   $$V_{\text{fornecedor\_pendente}} = V - P_{\text{total}}$$
   - **Regra Fundamental de Integridade:** Se $V_{\text{fornecedor\_pendente}} > 0$, esse montante **NÃO é dívida bilateral entre os participantes**. Trata-se de uma obrigação da despesa perante terceiros.
2. **Cota de Financiamento Efetivo de Cada Participante:**
   - Para cada participante $k$, o valor total que ele financiou perante o fornecedor é $P_{k}^{\text{funded}}$.
   - Parcela usada para cobrir a própria responsabilidade:
     $$\text{AutoCobertura}_k = \min(P_{k}^{\text{funded}}, R_k)$$
   - Parcela em que o participante financiou cotas de outros participantes (Excedente Credor):
     $$\text{ExcedenteCredor}_k = P_{k}^{\text{funded}} - \text{AutoCobertura}_k$$
3. **Identificação dos Participantes em Déficit:**
   - Cota paga de sua própria responsabilidade: $\text{AutoCobertura}_i$.
   - Déficit do participante na despesa:
     $$\text{Déficit}_i = R_i - \text{AutoCobertura}_i$$
4. **Segregação do Déficit: Fornecedor vs. Dívida Bilateral:**
   - O déficit de um participante $\text{Déficit}_i$ é composto por duas partes:
     a) **Dívida Bilateral Constituída com quem pagou além da cota:** O montante financiado pelos participantes que tiveram $\text{ExcedenteCredor} > 0$.
     b) **Déficit com o Fornecedor:** O saldo que ninguém pagou e continua pendente na despesa.
   - A soma de todos os $\text{ExcedenteCredor}_k$ é **estritamente igual** à soma das dívidas bilaterais constituídas em `BilateralDebtLedger`.
   - A soma das dívidas com o fornecedor é **estritamente igual** a $V_{\text{fornecedor\_pendente}}$.

---

# SEÇÃO 6: Matriz de Segurança Firestore Rules (Proteção Integral)

As regras abaixo são implementadas na camada de banco de dados do Firebase Firestore, garantindo que o Admin SDK (backend confiável) opere com autoridade contábil e o Client SDK seja estritamente limitado:

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

    // 1. Contas Pessoais: Privacidade Absoluta (Titular Exclusivo)
    match /accounts/{accountId} {
      allow read, write: if isAuthenticated() && request.auth.uid == resource.data.userId;
      allow create: if isAuthenticated() && request.auth.uid == request.resource.data.userId;
      
      match /private_payment_metadata/{paymentId} {
        allow read, write: if isAuthenticated() && request.auth.uid == get(/databases/$(database)/documents/accounts/$(accountId)).data.userId;
      }
    }

    // 2. Despesas Compartilhadas: Sem Autoaprovação e Proteção de Campos
    match /shared_expenses/{expenseId} {
      allow read: if isSpaceMember(resource.data.spaceId);
      
      // Criação: 100% dos usuários (inclusive donos) criam OBRIGATORIAMENTE com status pending_validation
      allow create: if isSpaceMember(request.resource.data.spaceId) &&
        request.resource.data.createdByUid == request.auth.uid &&
        request.resource.data.validationStatus == 'pending_validation' &&
        request.resource.data.totalPaidToSupplierCents == 0;

      // Atualização:
      // Caso A: Validação por TERCEIRO (Proibido aprovar a própria despesa)
      // Caso B: Edição pelo autor (Apenas se pending_validation ou rejected, e campos críticos imutáveis)
      allow update: if isSpaceMember(resource.data.spaceId) && (
        (
          // Validador NÃO pode ser o autor original
          request.auth.uid != resource.data.createdByUid &&
          request.resource.data.createdByUid == resource.data.createdByUid &&
          request.resource.data.totalOriginalAmountCents == resource.data.totalOriginalAmountCents &&
          request.resource.data.diff(resource.data).affectedKeys().hasOnly(['validationStatus', 'validatedByUid', 'validatedByName', 'validatedAt', 'rejectionReason']) &&
          (
            (request.resource.data.validationStatus == 'approved' && request.resource.data.validatedByUid == request.auth.uid) ||
            (request.resource.data.validationStatus == 'rejected' && request.resource.data.rejectionReason != null && request.resource.data.rejectionReason.size() > 5)
          )
        ) ||
        (
          // Autor corrigindo registro recusado ou pendente
          resource.data.createdByUid == request.auth.uid &&
          resource.data.validationStatus in ['pending_validation', 'rejected'] &&
          request.resource.data.validationStatus == 'pending_validation' &&
          request.resource.data.createdByUid == resource.data.createdByUid &&
          !request.resource.data.diff(resource.data).affectedKeys().hasAny(['validatedByUid', 'validatedAt', 'totalPaidToSupplierCents'])
        )
      );

      allow delete: if false; // Imutabilidade absoluta
    }

    // 3. Pagamentos de Despesas
    match /shared_expenses/{expenseId}/payments/{paymentId} {
      allow read: if isSpaceMember(get(/databases/$(database)/documents/shared_expenses/$(expenseId)).data.spaceId);
      allow create: if isSpaceMember(get(/databases/$(database)/documents/shared_expenses/$(expenseId)).data.spaceId) &&
        request.resource.data.executedByUid == request.auth.uid &&
        request.resource.data.validationStatus == 'pending_validation';
      
      // Validação por terceiro
      allow update: if isSpaceMember(get(/databases/$(database)/documents/shared_expenses/$(expenseId)).data.spaceId) &&
        request.auth.uid != resource.data.executedByUid &&
        request.auth.uid != resource.data.economicFunderUid &&
        request.resource.data.diff(resource.data).affectedKeys().hasOnly(['validationStatus', 'validatedByUid', 'validatedByName', 'validatedAt', 'rejectionReason']);
        
      allow delete: if false;
    }

    // 4. Débitos Bilaterais (Projeções Calculadas): Apenas Leitura para Clientes
    // Atualizações cadastrais ocorrem exclusivamente via Backend Transacional
    match /shared_expenses/{expenseId}/bilateral_debts/{debtId} {
      allow read: if isSpaceMember(get(/databases/$(database)/documents/shared_expenses/$(expenseId)).data.spaceId);
      allow write: if false; // Blindagem contra mutação client-side
    }

    // 5. Liquidações Bilaterais: Validação estrita pelo Credor
    match /settlement_records/{settlementId} {
      allow read: if isSpaceMember(resource.data.spaceId);
      allow create: if isSpaceMember(request.resource.data.spaceId) &&
        request.resource.data.debtorUid == request.auth.uid &&
        request.resource.data.validationStatus == 'pending_validation';
      
      // Somente o credor pode confirmar o recebimento
      allow update: if isSpaceMember(resource.data.spaceId) &&
        request.auth.uid == resource.data.creditorUid &&
        request.resource.data.diff(resource.data).affectedKeys().hasOnly(['validationStatus', 'validatedByUid', 'validatedAt']);
        
      allow delete: if false;
    }

    // 6. Quarentena da Migração: Acessível aos membros para conferência
    match /unresolved_legacy_transactions/{legacyTxId} {
      allow read: if isAuthenticated();
      allow write: if isAuthenticated(); // Permite resolução manual assistida
    }
  }
}
```

---

# SEÇÃO 7: Idempotência e Consistência Transacional em Operações Compostas

### 7.1. Mecanismo de Idempotência Atômica com TTL
1. **Geração do Identificador de Intenção:** Quando o usuário clica em "Salvar" ou "Liquidar", o cliente gera um UUID v4: `clientTransactionUuid`.
2. **Verificação Transacional no Firestore:**
   Dentro de um bloco `runTransaction(db, async (tx) => { ... })`:
   - O documento `/idempotency_keys/{clientTransactionUuid}` é lido.
   - Se o documento existir e tiver status `completed`: a transação é interrompida e o cliente recebe a resposta da execução original sem reprocessar débitos.
   - Se o documento não existir: a chave é gravada com `status: 'in_progress'` e `expiresAt: timestamp + 30 dias`.
3. **Escrita Atômica Composta:** No mesmo bloco atômico da transação:
   - Grava-se o `SharedExpense` (ou `ExpensePayment`);
   - Grava-se o `ResourceMovementEvent` (se fundo coletivo);
   - Atualiza-se o saldo do fundo `SharedResourcePool`;
   - Grava-se a chave de idempotência com `status: 'completed'`.
   - Se qualquer passo falhar ou houver timeout, a transação sofre **rollback automático** e nenhuma entidade fica órfã.

---

# SEÇÃO 8: Pipeline de Migração Histórica Não-Destrutiva

### 8.1. Classificação Estrutural Baseada no Código Auditado
A auditoria em `src/types/finance.ts` e `src/App.tsx` revelou como os registros legados foram gravados. A tabela abaixo dita a classificação:

| Evidência Estrutural no Documento Legado | Classificação Contábil no Novo Modelo | Entidade Nova Gerada | Ação se Falhar Validação |
| :--- | :--- | :--- | :--- |
| `tx.spaceId === ''` | **Transação Pessoal Individual** | Permanece 100% intocada na coleção original. | Nenhuma (Não entra na migração de espaços). |
| `tx.spaceId !== '' && tx.splits.length > 0 && tx.type === 'expense' && tx.paidByEmail !== 'space_cash'` | **Despesa Compartilhada Direta** | `SharedExpense` + `ExpenseLiability` (para cada split) + `ExpensePayment`. | Se $\sum \text{responsibility} \neq \text{amount}$: vai para **Quarentena**. |
| `tx.spaceId !== '' && tx.paidByEmail === 'space_cash'` | **Despesa Paga por Fundo Comum** | `SharedExpense` com pagamento de fonte `free_shared_pool`. | Se valor for negativo ou nulo: vai para **Quarentena**. |
| `tx.spaceId !== '' && tx.type === 'income' && tx.paidByEmail !== '' && !tx.recipientEmail` | **Aporte no Fundo de Reserva** | `ResourceMovementEvent` (`contribution`) em `resource_pool`. | Se não puder comprovar autoria: vai para **Quarentena**. |
| `tx.spaceId !== '' && tx.recipientEmail !== '' && tx.splits.length === 0` | **Liquidação / Acerto de Contas Legado** | `SettlementRecord` com alocação FIFO estimada. | Se devedor ou credor não existirem no cadastro: vai para **Quarentena**. |
| Qualquer transação com campos corrompidos, ausência de valores ou splits inconsistentes | **Registro Ambíguo** | Gravado integralmente em `unresolved_legacy_transactions`. | Preservado por tempo indeterminado com status `pending_manual_review`. |

### 8.2. Interface de Quarentena e Reconciliação
- Exibição em **tabela comparativa lado a lado**:
  - Coluna 1: Dados brutos legados (Data, Descrição, Valor, Pagador, Splits originais).
  - Coluna 2: Interpretação sugerida pelo sistema (com justificativa da dúvida).
  - Coluna 3: Seletor de Ação Humana com a **opção padrão fixada em "Manter em Quarentena"**:
    - `[Manter em Quarentena]` (Padrão)
    - `[Confirmar como Despesa Compartilhada]`
    - `[Confirmar como Aporte ao Fundo]`
    - `[Confirmar como Liquidação Bilateral]`
- Ao escolher uma ação e clicar em "Salvar Resolução", o sistema executa a migração assistida do registro com log de auditoria, retirando-o da quarentena.

---

# SEÇÃO 9: Parcelamentos e Faturas de Cartão (Confronto com o Código Atual)

### 9.1. Evidências Inspecionadas no Código Atual
A inspeção em `src/utils/financeEngine.ts:194-285` e `src/App.tsx:825-865` revelou:
1. **Inexistência de Entidade de Fatura:** Hoje não há coleção `invoices`. Faturas são apenas agrupamentos em tempo de renderização via `tx.invoiceMonth`.
2. **Falha Crítica na Liquidação de Fatura (`handlePayInvoice`):** O parâmetro `_sourceCheckingId` é ignorado. Ao pagar a fatura, o sistema apenas marca as transações como `paid`, sem debitar a conta bancária de origem.
3. **Parcelamento de Compras vs. Financiamento de Fatura:** O código atual trata compras parceladas gerando $N$ transações independentes com sufixo `(i/N)` e `paidAmount = 0` para $i > 0$. Não existe suporte a parcelamento de fatura vencida nem transporte de saldo rolado (*revolving*).

### 9.2. Modelo Revisado na v4.0
- **Compra Parcelada no Comércio:** `InstallmentPurchase` armazena o contrato original. Gera $N$ ocorrências de `SharedExpense` nas competências futuras correspondentes. O limite do cartão é comprometido integralmente, mas a fatura de cada mês recebe apenas a parcela devida.
- **Parcelamento de Saldo de Fatura Vencida:** Criada a entidade `InvoiceInstallmentPlan`. Quando o usuário financia um saldo não pago de fatura, essa operação **não duplica as compras antigas**. Gera um contrato financeiro de encargos separado, debitando parcelas mensais na conta corrente.

---

# SEÇÃO 10: Demonstração dos 28 Cenários Práticos Detalhados

Abaixo estão demonstrados todos os 28 cenários com valores numéricos, contas, débitos, créditos, saldos individuais e coletivos, cobrindo 100% das situações exigidas.

---

#### Cenário 1: Despesa Paga Integralmente por um Participante
*Dados:* Keniel compra R$ 400,00 no mercado (cota R$ 200 Keniel / R$ 200 Mariana). Paga com sua conta corrente Nubank.
- **Registros:** `SharedExpense` (R$ 400), `ExpenseLiability` (Keniel R$ 200 / Mariana R$ 200), `ExpensePayment` (R$ 400, `executedByUid: Keniel`, `economicFunderUid: Keniel`, Nubank, `pending_validation`).
- **Validação:** Mariana acessa a Central de Validações e aprova. Status passa para `approved`.
- **Efeitos Financeiros:**
  - Conta Nubank de Keniel debita R$ 400,00.
  - Perante o fornecedor: despesa 100% quitada (`supplierUnpaidBalanceCents = 0`).
  - `BilateralDebtLedger`: Mariana deve R$ 200,00 a Keniel.
  - Visão Geral de Keniel: Saída bancária de R$ 400, compensada por crédito patrimonial de +R$ 200 a receber de Mariana. Gasto próprio efetivo: R$ 200,00.

---

#### Cenário 2: Despesa Paga Parcialmente por Dois Participantes
*Dados:* Conta de água de R$ 300,00 (cota R$ 150 cada). Keniel paga R$ 200,00 e Mariana paga R$ 100,00.
- **Registros:** 2 `ExpensePayment` aprovados por validação cruzada.
- **Cálculo:** Fornecedor recebeu R$ 300 (quitado). Keniel pagou R$ 50 acima de sua cota de R$ 150; Mariana pagou R$ 50 abaixo de sua cota de R$ 150.
- **BilateralDebtLedger:** Mariana deve exatamente **R$ 50,00 para Keniel**.

---

#### Cenário 3: Transferência para Terceiro Pagar Conta (Adiantamento)
*Dados:* Mariana transfere R$ 300,00 via PIX para Keniel pagar o condomínio.
- **Registros:** `AdvanceTransfer` (R$ 300, sender: Mariana, custodian: Keniel, `targetExpenseId: condominio`).
- **Validação:** Keniel confirma o recebimento na sua conta bancária.
- **Efeito Bancário:** Conta de Mariana -R$ 300; conta de Keniel +R$ 300 (com passivo de custódia vinculado de R$ 300, sem inflar sua receita pessoal).
- **Espaço:** O condomínio continua constando como `unpaid` perante o fornecedor até o pagamento efetivo.

---

#### Cenário 4: Contribuição para o Fundo de Reserva Coletivo
*Dados:* Keniel aporta R$ 250,00 de sua conta pessoal no Fundo de Reserva.
- **Registros:** `ResourceMovementEvent` (`contribution`, R$ 250, author: Keniel, `pending_validation`).
- **Validação:** Mariana aprova o aporte na Central de Validações.
- **Efeito:** Conta de Keniel debita R$ 250,00. O Fundo Coletivo aumenta R$ 250,00. Nenhuma dívida bilateral é criada para Mariana (o fundo é coletivo indivisível).

---

#### Cenário 5: Pagamento de Despesa com Recursos do Fundo de Reserva
*Dados:* Compra de lâmpadas de R$ 80,00 paga com o Fundo de Reserva (saldo de R$ 250).
- **Registros:** `SharedExpense` (R$ 80), `ExpensePayment` (R$ 80, `fundingSource: free_shared_pool`, `pending_validation`).
- **Validação:** Gestor ou outro membro aprova.
- **Efeito:** Nenhuma conta bancária de participante é debitada. O Fundo de Reserva cai de R$ 250 para R$ 170. A despesa fica quitada perante o fornecedor e **nenhum participante contrai dívida bilateral**.

---

#### Cenário 6: Despesa Cancelada Após Pagamento com Devolução Total
*Dados:* Keniel pagou R$ 600,00 em curso online (R$ 300 Keniel / R$ 300 Mariana). O curso foi cancelado e o fornecedor devolveu R$ 600 na conta de Keniel.
- **Registros:** `ExpenseRefundEvent` (`full_refund`, R$ 600, creditado na conta de Keniel).
- **Efeito:** O valor original da despesa (R$ 600) é preservado no histórico. O status vai para `closed`. A dívida bilateral de Mariana com Keniel é extinta ($R\$ 0,00$).

---

#### Cenário 7: Liquidação Bilateral e Reversão Histórica sem Apagar Dados
*Dados:* Mariana deve R$ 100 a Keniel. Mariana faz PIX de R$ 100 para Keniel e registra a liquidação.
- **Passo 1 (Liquidação):** `SettlementRecord` criado como `pending_validation`. Keniel confere o PIX e aprova. A dívida em `BilateralDebtLedger` é amortizada em R$ 100 (FIFO).
- **Passo 2 (Reversão):** Descobre-se que o banco cancelou o PIX. Keniel solicita reversão e Mariana aprova. Gera-se um `SettlementReversionEvent`. O registro original de liquidação passa para status `reverted` e a dívida de R$ 100 em `BilateralDebtLedger` volta a ficar aberta. Nenhum documento é apagado.

---

#### Cenário 8: Fatura de Cartão Paga Parcialmente e Transportada
*Dados:* Fatura de cartão de Keniel com R$ 1.000 de compras do espaço. Keniel paga R$ 600 e rola R$ 400.
- **Registros:** Saída bancária de R$ 600 na conta corrente de Keniel. Gera-se `InvoiceCarryOver` de R$ 400 para o mês seguinte. As responsabilidades dos demais participantes perante Keniel não são afetadas pelos encargos de atraso individuais do cartão de Keniel.

---

#### Cenário 9: Compra Parcelada Compartilhada (3x de R$ 1.000)
*Dados:* Compra de geladeira de R$ 3.000 em 3x no cartão de Keniel (cota de R$ 500/mês para Mariana).
- **Registros:** `InstallmentPurchase` de R$ 3.000. São geradas 3 despesas mensais de R$ 1.000 alocadas nas respectivas faturas futuras. Mariana assume a obrigação de R$ 500 mês a mês, sem sobrecarregar o mês atual.

---

#### Cenário 10: Operação Criada Aguardando Validação
*Dados:* Mariana cadastra despesa de R$ 180 paga em dinheiro.
- **Registros:** Status fixado em `pending_validation`.
- **Saldos:** Saldo oficial inalterado. Keniel recebe alerta no cabeçalho e notificação na Central de Validações.

---

#### Cenário 11: Três Participantes, Múltiplos Pagadores e Despesa Parcialmente Paga
*Dados:* Manutenção predial de R$ 900,00 dividida igualmente entre Keniel, Mariana e Carlos (R$ 300,00 cada).
- **Pagamentos Aprovados:** Keniel paga R$ 400,00; Mariana paga R$ 200,00; Carlos paga R$ 0,00.
- **Total Pago ao Fornecedor:** R$ 600,00. Saldo devido ao fornecedor: **R$ 300,00**.
- **Cálculo Contábil:**
  - Saldo pendente do fornecedor: R$ 300,00 (`supplierUnpaidBalanceCents`).
  - Keniel: Responsabilidade R$ 300, pagou R$ 400 $\rightarrow$ Cobriu sua cota e tem **R$ 100 de Excedente Credor**.
  - Mariana: Responsabilidade R$ 300, pagou R$ 200 $\rightarrow$ Cobriu R$ 200 de sua cota, ficando com **déficit próprio de R$ 100**.
  - Carlos: Responsabilidade R$ 300, pagou R$ 0 $\rightarrow$ **Déficit próprio de R$ 300**.
- **Constituição de Dívida Bilateral:** O excedente de Keniel (R$ 100) financiou parte do déficit de Carlos.
  - `BilateralDebtLedger`: Carlos deve **R$ 100,00 para Keniel**.
  - O restante do déficit de Carlos (R$ 200) e o déficit de Mariana (R$ 100) somam exatamente os **R$ 300 devidos ao fornecedor**!
- **Auditoria:** Não se cria dívida fictícia de Mariana com Keniel nem de Carlos com Mariana.

---

#### Cenário 12: Adiantamento Parcialmente Utilizado e Devolvido
*Dados:* Mariana adianta R$ 300 para Keniel. Keniel gasta R$ 180 na despesa e devolve R$ 120 via PIX para Mariana.
- **Passo 1:** Adiantamento aprovado com saldo de R$ 300.
- **Passo 2:** Uso de R$ 180 aprovado. `AdvanceEvent` (`usage`). Saldo do adiantamento cai para R$ 120. A despesa não provoca nova saída bancária de Keniel.
- **Passo 3:** Devolução de R$ 120 aprovada. `AdvanceEvent` (`return`). Conta de Keniel debita R$ 120; conta de Mariana credita R$ 120. Saldo do adiantamento fecha em R$ 0 (`exhausted`).

---

#### Cenário 13: Fundo Coletivo Utilizado em Despesa sem Cobrança Duplicada
*Dados:* Keniel aporta R$ 250 no Fundo. O espaço usa R$ 80 em despesa aprovada.
- **Efeito:** O saldo do fundo cai de R$ 250 para R$ 170. Como o pagamento foi financiado pelo fundo coletivo, **nenhum registro é gerado em `BilateralDebtLedger`**. Mariana não deve nada e Keniel não recebe crédito extra.

---

#### Cenário 14: Despesa Cancelada com Devolução Parcial (Preservação do Histórico)
*Dados:* Despesa de R$ 600 (Keniel R$ 300 / Mariana R$ 300), paga por Keniel via Nubank. Fornecedor cancela e devolve apenas R$ 400 (multa de R$ 200 retida).
- **Preservação:** O documento original mantém `totalOriginalAmountCents = 60000`.
- **Registro do Estorno:** `ExpenseRefundEvent` registra devolução de R$ 400 na conta de Keniel e perda irrecuperável de R$ 200.
- **Ajuste:** A cota de responsabilidade de cada um é ajustada para R$ 100 (`adjustedShareAmountCents`).
- **Dívida Bilateral:** Mariana deve **R$ 100,00 para Keniel** em `BilateralDebtLedger`.

---

#### Cenário 15: Reversão de Liquidação Alocada
*Dados:* Liquidação de R$ 100 de Mariana para Keniel amortizou duas dívidas passadas via FIFO (R$ 70 de outubro e R$ 30 de novembro). A liquidação foi estornada por inconsistência bancária.
- **Efeito:** Gera-se `SettlementReversionEvent`. As duas dívidas em `BilateralDebtLedger` têm seus saldos devedores recompostos (outubro volta a dever R$ 70 e novembro volta a dever os R$ 30). Nenhuma alocação é apagada do histórico.

---

#### Cenário 16: Cancelamento Parcial de Compra Parcelada Futura
*Dados:* Compra de 3x de R$ 1.000. A 1ª parcela foi paga. O contrato foi rescindido e a operadora cancelou as parcelas 2 e 3.
- **Efeito:** A parcela 1 paga permanece intacta no histórico. As parcelas 2 e 3 têm o status alterado para `cancelled_pre_payment`, sem impacto em faturas futuras e sem cobrança dos participantes.

---

#### Cenário 17: Operação Recusada, Corrigida e Reenviada
*Dados:* Mariana cadastra despesa de R$ 250.
- **Passo 1:** Keniel confere o recibo e recusa com o motivo: *"Valor na nota é R$ 200 e não R$ 250"*. Status vai para `rejected`.
- **Passo 2:** Mariana edita o valor para R$ 200 e clica em "Reenviar". Status volta para `pending_validation`.
- **Passo 3:** Keniel confere e clica em "Aprovar". Apenas agora a operação entra no saldo oficial. O log de auditoria registrou todas as etapas.

---

#### Cenário 18: Pagamento Misto: Adiantamento de Terceiro + Recurso Próprio
*Dados:* Mariana adiantou R$ 200 para Keniel. A conta de luz veio em R$ 350 (cota R$ 175 cada). Keniel paga a conta usando os R$ 200 de Mariana + R$ 150 do seu bolso.
- **Registros:**
  - `Payment 1`: R$ 200, `executedByUid: Keniel`, `economicFunderUid: Mariana`, fonte: `advance_transfer`.
  - `Payment 2`: R$ 150, `executedByUid: Keniel`, `economicFunderUid: Keniel`, fonte: `personal_checking`.
- **Cálculo Contábil:**
  - Mariana financiou R$ 200 (sua cota era R$ 175 $\rightarrow$ excedente financiado de R$ 25).
  - Keniel financiou R$ 150 (sua cota era R$ 175 $\rightarrow$ déficit de R$ 25).
- **BilateralDebtLedger:** **Keniel deve R$ 25,00 para Mariana!**

---

#### Cenário 19: Despesa Parcialmente Paga sem Criação Indevida de Dívida Bilateral
*Dados:* Compra de R$ 400 (R$ 200 Keniel / R$ 200 Mariana). Keniel paga R$ 100 ao fornecedor e Mariana paga R$ 0.
- **Cálculo:** Fornecedor recebeu R$ 100; restam R$ 300 devidos ao fornecedor. Keniel pagou R$ 100 da sua própria cota de R$ 200 (não teve excedente).
- **Resultado:** `BilateralDebtLedger` entre Keniel e Mariana registra **R$ 0,00**. Não há dívida entre eles, pois Keniel ainda não cobriu nem sua própria cota.

---

#### Cenário 20: Pagamento Simultâneo por Três Fontes (Conta, Cartão e Fundo)
*Dados:* Reforma de R$ 1.200 (cota de R$ 400 cada para Keniel, Mariana e Carlos).
- **Pagamentos:** Keniel paga R$ 400 no cartão; Mariana paga R$ 400 via débito; R$ 400 são pagos usando o Fundo de Reserva.
- **Resultado:** A despesa está 100% quitada no fornecedor. O fundo caiu R$ 400. Keniel e Mariana cobriram suas cotas. Como a terceira cota foi paga pelo Fundo Coletivo, Carlos não deve nada a ninguém!

---

#### Cenário 21: Participante que Deixa o Espaço com Pendências
*Dados:* Carlos sai do espaço devendo R$ 100 a Keniel.
- **Regra:** O status de Carlos no espaço passa para `archived_member`. Ele perde acesso para criar novas despesas, mas suas dívidas em `BilateralDebtLedger` permanecem ativas e visíveis para Keniel e Carlos até sua liquidação.

---

#### Cenário 22: Responsável Cria Operação e Submete a Outro Participante
*Dados:* Keniel (responsável) cadastra compra de R$ 150.
- **Regra de Alçada 100%:** A despesa entra com status `pending_validation`. Keniel **não pode aprovar**. Mariana recebe a solicitação na Central de Validações e aprova.

---

#### Cenário 23: Tentativa de Autoaprovação Bloqueada no Banco
*Dados:* Um usuário tenta disparar requisição direta no Firestore aprovando uma despesa criada por ele mesmo.
- **Regra:** A regra `request.auth.uid != resource.data.createdByUid` rejeita a escrita com erro `PERMISSION_DENIED`. A interface bloqueia o botão de aprovação para o próprio autor.

---

#### Cenário 24: Reembolso Parcial do Fornecedor Após Liquidação entre Membros
*Dados:* Despesa de R$ 400 paga por Keniel (cota R$ 200 Mariana). Mariana liquidou seus R$ 200 para Keniel. Dias depois, o fornecedor ressarciu R$ 100 na conta de Keniel por um defeito.
- **Ajuste:** A perda líquida passa a ser R$ 300 (R$ 150 cada). Como Mariana já havia pago R$ 200 a Keniel, gera-se um crédito de **R$ 50 de Keniel em favor de Mariana** via `BilateralDebtLedger`.

---

#### Cenário 25: Adiantamento Não Vinculado Utilizado em Múltiplas Despesas
*Dados:* Mariana transfere R$ 500 livres para Keniel gerenciar compras da semana.
- **Uso:** Keniel usa R$ 200 na despesa de supermercado e R$ 150 na despesa de farmácia. O saldo do adiantamento cai sequencialmente para R$ 300 e depois para R$ 150, gerando eventos auditáveis em `advance_events`.

---

#### Cenário 26: Operação Aprovada, mas Não Executada Financeiramente
*Dados:* Uma despesa de R$ 300 foi aprovada no sistema, mas o pagamento do boleto falhou no aplicativo bancário.
- **Regra:** A aprovação administrativa não é comprovante de liquidação bancária. A despesa permanece em `paymentExecutionStatus = 'unpaid'` até que o comprovante bancário seja anexado.

---

#### Cenário 27: Operação Executada e Posteriormente Revertida
*Dados:* Pagamento de R$ 180 em dinheiro registrado e aprovado. Descobriu-se que o dinheiro não foi entregue.
- **Regra:** O gestor solicita reversão com justificativa. A outra parte aprova. O status do pagamento passa para `cancelled`, recompondo a dívida perante o fornecedor sem apagar o histórico original.

---

#### Cenário 28: Duas Solicitações Concorrentes para a Mesma Obrigação
*Dados:* Keniel e Mariana tentam registrar a liquidação do mesmo saldo de R$ 100 quase simultaneamente.
- **Regra:** A transação atômica em `runTransaction` lê o saldo devedor atualizado. A primeira transação liquida o débito. A segunda lê o saldo devedor já zerado e aborta a operação com a mensagem: *"Esta obrigação já foi liquidada por outro participante."*

---

# SEÇÃO 11: Interface e Experiência do Usuário

Conforme as diretrizes aprovadas:
1. **Indicador de Pendências no Cabeçalho:** Um card compacto e elegante no topo do Espaço exibe: *"X operações aguardando sua validação"*, funcionando como alerta imediato.
2. **Central de Validações Dedicada:** Área de trabalho que consolida todas as solicitações pendentes (despesas, pagamentos, liquidações, adiantamentos e aportes), permitindo aprovar, recusar com justificativa obrigatória ou solicitar esclarecimentos.
3. **Tela de Quarentena da Migração:** Tabela comparativa lado a lado que exibe os dados brutos antigos, a interpretação técnica sugerida, o impacto estimado e a ação humana explícita, mantendo por padrão a opção **"Manter em Quarentena"**.

---

# SEÇÃO 12: Riscos Residuais e Dúvidas Finais

1. **Risco Residual de Escalabilidade de Leituras:**
   - *Mitigação:* Denormalização estrita dos totalizadores de status no documento pai `SharedExpense`, evitando consultas em cascata em listagens simples.
2. **Dúvida Real Pendente de Sua Decisão:**
   - Em caso de **dissolvimento/exclusão definitiva de um Espaço Compartilhado que ainda possua saldo positivo no Fundo de Reserva**, qual deve ser o fluxo padrão sugerido:
     - **Opção A:** Exigir devolução formal proporcional aos aportes históricos comprovados antes de permitir a exclusão;
     - **Opção B:** Exigir que o saldo seja zerado mediante retirada autorizada aprovada por todos os participantes.

---

# Conclusão e Próximo Passo

Esta Especificação Arquitetural e Contábil v4.0 corrige todas as inconsistências apontadas, elimina totalmente a autoaprovação, protege os dados bancários privados em nível de banco de dados, estabelece a matemática exata para pagamentos parciais e múltiplos financiadores e demonstra 28 cenários práticos auditados.

O documento normativo integral está registrado no artefato **`especificacao_arquitetura_financeira_definitiva_v4.md`**.

Reiterando: **nenhuma implementação foi iniciada.** Aguardamos sua homologação desta arquitetura e sua escolha sobre a dúvida de encerramento do Fundo para que possamos, mediante sua autorização formal, estruturar o plano de desenvolvimento.
