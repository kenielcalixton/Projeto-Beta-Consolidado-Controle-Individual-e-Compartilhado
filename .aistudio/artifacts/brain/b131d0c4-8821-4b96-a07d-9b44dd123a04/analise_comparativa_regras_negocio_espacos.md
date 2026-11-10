# Estudo de Viabilidade e Arquitetura Comparativa
## Proposta de Regras de Negócio vs. Implementação Atual dos Espaços Compartilhados

**Data de Emissão:** 09 de Novembro de 2026  
**Status:** Análise Prévia de Engenharia de Software (Sem alterações no código ou banco)  
**Documento Base:** *Proposta de regras de negócio — Financeiro dos Espaços Compartilhados* e *Diagnóstico da Lógica Atual*.

---

## 1. O que já existe e pode ser preservado (Aproveitamento Máximo)

A arquitetura atual possui alicerces sólidos que devem ser mantidos para evitar retrabalho:

| Componente / Recurso | Status Atual | Grau de Preservação | Justificativa Técnica |
| :--- | :--- | :--- | :--- |
| **Autenticação e Perfis (`UserProfile`)** | Firebase Auth + Perfis em `users` com `uid`, `name`, `email` | **100% Preservado** | Identificadores estáveis (`uid`) já estão desacoplados do e-mail. |
| **Contas e Cartões (`Account`)** | `checking` (corrente) e `credit` (cartão) com `limit`, `closingDay`, `dueDay` | **95% Preservado** | Estrutura de contas atende à segregação de saídas bancárias e limite de cartões. |
| **Categorias (`Category`)** | Sistema global e customizável de despesas e receitas | **100% Preservado** | Totalmente compatível com a visão compartilhada. |
| **Critérios de Rateio (`SplitShare`)** | Suporta rateio igualitário, porcentagens e valores personalizados | **90% Preservado** | O cálculo com compensação de centavos residuais (`calculateSpaceLedger`) já é robusto. Precisa apenas desacoplar o campo `paid` (desembolso) do rateio de obrigação. |
| **Recorrências Individuais (`RecurrencePattern`)** | Geração e identificação de repetições | **80% Preservado** | O motor de templates e geração pode ser reaproveitado para as recorrências de grupo. |
| **Módulos do Espaço (`enabledModules`)** | Flagging modular de compras, finanças, tarefas | **100% Preservado** | Permite ativar/desativar módulos por espaço sem quebrar o core. |
| **Listas de Compras (`ShoppingItem`)** | Criação, atribuição de membro e status `purchased` | **90% Preservado** | A tela de conclusão de compra já possui os dados de valor e itens prontos para o hook de conversão em despesa. |

---

## 2. O que precisa ser adaptado (Refatoração do Core)

As principais mudanças exigidas pela proposta demandam substituir lógicas "virtuais/calculadas em tempo de renderização" por modelos relacionais auditáveis:

### 2.1. Da Lógica Estritamente Mensal para Saldo Histórico Acumulado
- **Como é hoje:** O Livro-Razão filtra rigorosamente `tx.invoiceMonth === selectedMonth`. Na virada do mês, o saldo anterior desaparece.
- **Adaptação necessária:** O motor deve calcular o **Saldo Acumulado Transitado (`carryOverBalance`)** somando todas as obrigações e pagamentos históricos anteriores à competência aberta. O mês vira uma janela de visualização das *movimentações do período*, mantendo o card superior com o saldo pendente consolidado geral.

### 2.2. Desacoplamento entre Obrigação (Despesa) e Desembolso (Pagamentos)
- **Como é hoje:** A transação possui `amount` único e uma conta bancária única de débito (`accountId`), assumindo que a compra é paga integralmente no ato por quem a registrou.
- **Adaptação necessária:** A despesa passa a representar a **obrigação contratual original** com `totalAmount`, `status` (`pending`, `partial`, `paid`, `cancelled`), enquanto os pagamentos passam a ser registros filhos (`ExpensePayment`), permitindo múltiplas origens, pagamentos parciais e datas distintas.

### 2.3. Transações de Reembolso / Liquidação
- **Como é hoje:** Liquidação é uma transação comum com texto sintético `"Reembolso Livro-Razão:"`, sem vínculo com as despesas que geraram o saldo devedor.
- **Adaptação necessária:** A liquidação passa a ser uma entidade explícita (`SettlementRecord`) com tabela de alocação indicando exatamente quais despesas anteriores estão sendo amortizadas (critério FIFO por antiguidade, com ajuste manual).

### 2.4. Liquidação da Fatura de Cartão de Crédito (`handlePayInvoice`)
- **Como é hoje:** O método apenas altera o status das transações do cartão para `paid`, ignorando a conta bancária informada e sem criar débito real na conta corrente.
- **Adaptação necessária:** Gerar a saída financeira real na conta bancária de origem e permitir o pagamento parcial de faturas, com transporte de saldo ou parcelamento.

---

## 3. Novas Entidades e Relacionamentos Necessários

Para atender com rigor contábil às regras validadas, propõe-se o seguinte modelo relacional:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                 ESPAÇO                                   │
│  Space: { id, name, members: [{uid, role, joinedAt}], ownerId }          │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │ 1:N
         ┌───────────────────────────┼──────────────────────────┐
         │ 1:N                       │ 1:N                      │ 1:N
         ▼                           ▼                          ▼
┌──────────────────┐       ┌──────────────────┐       ┌────────────────────┐
│  SharedExpense   │       │   SharedResource │       │  SettlementRecord  │
│  (A Obrigação)   │       │ (Recurso Coletivo│       │   (Liquidação)     │
└────────┬─────────┘       └────────┬─────────┘       └─────────┬──────────┘
         │                          │                           │
         │ 1:N                      │ 1:N                       │ 1:N
         ▼                          ▼                           ▼
┌──────────────────┐       ┌──────────────────┐       ┌────────────────────┐
│  ExpensePayment  │       │ ResourceMovement │       │SettlementAllocation│
│  (Os Pagamentos) │       │ (Aportes/Baixas) │       │(Quais dívidas pagou│
└──────────────────┘       └──────────────────┘       └────────────────────┘
```

### Especificação das Novas Estruturas:

1. **`ExpensePayment` (Pagamentos da Despesa):**
   - `id`: string
   - `expenseId`: string (referência à despesa compartilhada)
   - `amount`: number (valor pago nesta amortização)
   - `paidBy`: string (uid do membro pagador)
   - `sourceType`: `'personal_account'` | `'credit_card'` | `'shared_resource'` | `'cash'`
   - `sourceAccountId`?: string (conta corrente ou cartão individual utilizado)
   - `date`: string (ISO)
   - `validationStatus`: `'pending_approval'` | `'approved'` | `'rejected'`
   - `notes`?: string

2. **`AdvanceTransfer` (Transferências e Adiantamentos Vinculados):**
   - `id`: string
   - `spaceId`: string
   - `senderUid`: string
   - `receiverUid`: string
   - `targetExpenseId`?: string (despesa pretendida)
   - `totalAmount`: number
   - `usedAmount`: number
   - `status`: `'available'` | `'partially_used'` | `'fully_used'` | `'returned'` | `'converted'`
   - `history`: Array com log de devoluções parciais ou conversões autorizadas.

3. **`SharedResource` / `ResourceMovement` (Controle Dinâmico de Recursos):**
   - Substitui o antigo `availableSpaceCash` (que era volátil) por uma trilha de auditoria:
   - Toda entrada registra quem enviou, valor, data e comprovante.
   - Toda saída registra a despesa correspondente, valor abatido e aprovação do responsável.

4. **`SettlementRecord` & `SettlementAllocation`:**
   - Registra a transferência direta entre membros para quitar saldos passados.
   - Lista detalhada de quais obrigações históricas tiveram seus saldos devedores reduzidos.

5. **`FinancialActionAudit` (Trilha de Validação e Aprovação):**
   - Para atender à diretriz de validação pelo responsável: guarda status (`pending_approval`, `approved`, `rejected`), data da análise, autor do despacho e justificativa de recusa.

---

## 4. Estratégia de Migração e Compatibilidade com Dados Existentes

Como o sistema já possui transações cadastradas em produção/desenvolvimento, a transição deve ser **100% retrocompatível e não-destrutiva**:

1. **Compatibilidade de Leitura (Bridge Adapter):**
   - O array de `transactions` atual continuará sendo reconhecido pelo backend.
   - Toda transação legada que possuir `spaceId` será tratada internamente como um `SharedExpense` cujo único `ExpensePayment` foi executado no valor integral pelo `createdById`.
2. **Flag de Versão do Espaço (`schemaVersion: 2`):**
   - Espaços existentes operam com regras legadas até serem migrados ou apenas novas movimentações adotam as estruturas avançadas.
3. **Nenhuma perda de lançamentos individuais:**
   - Transações pessoais (`!spaceId`) permanecem absolutamente intocadas e isoladas.

---

## 5. Grafo de Dependências entre as Funcionalidades Propostas

Para implementar as regras com eficiência e sem loops de dependência, a ordem ótima de engenharia deve seguir esta cadeia:

```
[Fase 1: Modelo e Motor Contábil Base]
    ├── 1.1 Desacoplamento Despesa vs. Pagamento (ExpensePayment)
    ├── 1.2 Motor de Saldo Acumulado Multimês (FIFO Carry-Over)
    └── 1.3 Cálculo de Obrigações Pendentes por Participante
             │
             ▼
[Fase 2: Fluxos de Amortização e Liquidação]
    ├── 2.1 Pagamentos Parciais de Despesas
    ├── 2.2 Liquidação Sugerida por FIFO com Ajuste Manual
    └── 2.3 Estorno Auditável de Liquidações
             │
             ▼
[Fase 3: Adiantamentos, Recursos Compartilhados e Workflow]
    ├── 3.1 Transferências Vinculadas & Adiantamentos com Fluxo de Reversão
    ├── 3.2 Caixa Coletivo Dinâmico (Aportes e Baixas Vinculadas)
    └── 3.3 Fila de Validação pelo Responsável do Espaço
             │
             ▼
[Fase 4: Integrações Avançadas e Faturas]
    ├── 4.1 Integração Compras de Lista -> Criação de Despesa
    ├── 4.2 Faturas de Cartão (Pagamento Parcial, Transporte e Antecipação)
    └── 4.3 Recorrências com Confirmação em Lote
```

---

## 6. Riscos para o Histórico Financeiro e Integridade Contábil

| Risco Identificado | Impacto | Mecanismo de Prevenção Proposto |
| :--- | :--- | :--- |
| **Dupla Contabilização de Liquidação** | A transferência bancária entre participantes ser somada como despesa de consumo do Espaço. | Isolar liquidações em tipo contábil próprio (`SETTLEMENT_TRANSFER`), que afeta exclusivamente a tabela de compensação e as contas bancárias, sem compor a métrica de "Gastos do Mês". |
| **Divergência entre Desembolso e Saldo Bancário** | Registrar que uma despesa foi paga sem haver o débito na conta de origem informada. | Transação atômica no banco: ao salvar o pagamento da despesa, gera-se simultaneamente a saída bancária na conta pessoal do pagador. |
| **Descompasso em Aprovações Pendentes** | Um participante cadastrar uma despesa de R$ 1.000 que fica pendente de aprovação, alterando saldos antes do aval. | Manter duas linhas de visão: **Saldo Oficial Conciliado** (apenas operações aprovadas) e **Saldo Projetado** (inclui pendências sob aviso visual claro). |
| **Quebra de Arredondamento em Rateios Fracionados** | Centavos residuais somarem valores divergentes do montante principal. | Algoritmo determinístico de centavo residual: o centavo excedente é automaticamente alocado ao membro pagador ou ao primeiro participante da lista de rateio. |

---

## 7. Análise e Respostas Técnicas para os 7 Pontos Pendentes (Seção 13)

Abaixo estão as recomendações de engenharia para cada uma das 7 dúvidas levantadas no documento do usuário:

### Ponto 1: Validação pelo Responsável do Espaço
*Dúvida:* Todas as operações precisam de aprovação antes de afetar os saldos? O que fazer com operações criadas pelo próprio responsável?  
- **Recomendação Técnica:** 
  1. Operações criadas pelo **próprio responsável são automaticamente aprovadas no ato** (autoaprovação implícita com log).
  2. Operações criadas por **membros comuns entram como `pending_approval`**. 
  3. No Livro-Razão e Dashboard, os saldos oficiais mostram apenas o aprovado, e um card destacado exibe: *"X operações pendentes de aprovação (Impacto previsto: R$ Y)"*. Isso impede fraudes ou erros de digitação sem travar a transparência visual.

### Ponto 2: Recursos Compartilhados sem Destinação Específica
*Dúvida:* Quando alguém contribui sem destinar a uma despesa, o valor fica livre para o grupo ou precisa de aprovação?  
- **Recomendação Técnica:**  
  O recurso entra como **"Saldo Livre do Espaço"** (fundo de reserva comum). Qualquer membro pode propor o abatimento de uma despesa com esse saldo, porém a **baixa efetiva só é debitada após aprovação do responsável**.

### Ponto 3: Cancelamento de Despesa Paga a Fornecedor sem Reembolso
*Dúvida:* Se uma despesa já foi paga a um terceiro e não há devolução do dinheiro, como tratar?  
- **Recomendação Técnica:**  
  Diferenciar **Cancelamento Contratual** de **Perda Financeira**. Se o dinheiro já saiu do bolso de um membro e a compra foi perdida/não reembolsada pelo fornecedor, o gasto ainda existiu e as responsabilidades de rateio devem ser honradas pelos participantes, alterando apenas o status da despesa para *"Encerrada (Sem Reembolso)"*. O cancelamento que zera dívidas só é permitido se o dinheiro retornou integralmente a quem desembolsou.

### Ponto 4: Distribuição de Encargos, Multas e Juros
*Dúvida:* Como distribuir encargos quando o atraso foi causado por um membro vs. atraso do grupo?  
- **Recomendação Técnica:**  
  No modal de registro de encargos, oferecer duas opções:
  1. **"Atribuir encargo a membro específico"** (o valor do juro entra 100% na responsabilidade do culpado).
  2. **"Ratear encargo entre os participantes"** (aplica o critério de divisão padrão da despesa original).

### Ponto 5: Parcelamento de Fatura de Cartão
*Dúvida:* Quais informações devem ser registradas no parcelamento de fatura?  
- **Recomendação Técnica:**  
  Criar a entidade `InvoiceInstallmentPlan`:
  - `originalInvoiceMonth`: mês da fatura parcelada.
  - `totalFinanced`: valor financiado (saldo restante não pago).
  - `installmentsCount`: número de parcelas (ex: 6x).
  - `interestRate` / `totalWithInterest`: montante total com taxa de financiamento.
  - O sistema gera automaticamente os débitos futuros em cada fatura subsequente como *"Parcelamento de Fatura Anterior (N/X)"*.

### Ponto 6: Compras Parceladas no Espaço Compartilhado
*Dúvida:* Compatibilidade com a lógica atual de parcelamento individual.  
- **Recomendação Técnica:**  
  Compatibilidade total! O sistema já possui geração de `installments` por recorrência/parcelas. Para o Espaço Compartilhado, cada parcela é uma ocorrência de competência futura com seu respectivo `SplitShare` mensal, preservando a cota de cada um mês a mês.

### Ponto 7: Liquidações Múltiplas Agrupadas
*Dúvida:* Manter na primeira versão liquidações entre pares dentro de uma operação agrupada?  
- **Recomendação Técnica:**  
  **Sim, fortemente recomendado.** Resolver matematicamente por pares (A paga B, B paga C) mantém a rastreabilidade contábil impecável, permite estornar uma transferência específica sem invalidar as demais e simplifica a conferência de comprovantes PIX/ted bancários.

---

## 8. Conclusão e Próximos Passos

A proposta de regras de negócio enviada pelo usuário é **plenamente viável** e representa um salto qualitativo indispensável para transformar os Espaços Compartilhados em um sistema financeiro de nível profissional, auditável e resiliente.

Conforme a diretriz expressa:
> *"Nenhuma alteração no código, banco de dados ou estrutura atual deve ser realizada antes da análise e aprovação da arquitetura proposta."*

Esta análise encerra a fase de diagnóstico prévio. Ficamos no aguardo da sua avaliação destas definições e da validação final dos 7 pontos para formular o plano de implementação passo a passo.
