import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Wallet,
  Building2,
  CreditCard,
  Plus,
  RefreshCw,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  AlertCircle,
  CheckCircle2,
  Calendar,
  X,
  DollarSign,
  ShieldCheck,
  Tag,
  Target,
  RotateCcw,
  SlidersHorizontal,
  ChevronRight,
  TrendingUp,
  Receipt,
  FileText,
  Clock,
  Ban,
  CheckCircle,
  Repeat,
  Layers,
  CalendarClock,
  Pause,
  Play,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import {
  Account,
  CentsInteger,
  CompetenceMonthString,
  CreditCardInvoice,
  DateString,
  InternalAccountTransfer,
  PersonalBudgetProgress,
  PersonalCategory,
  PersonalRefund,
  PersonalTransaction,
  PersonalTransactionStatus,
  PersonalTransactionType,
  RecurrenceRule,
  RecurrenceRuleNature,
  InstallmentContract,
  InstallmentContractFundingSource,
  InstallmentOccurrence,
  RecurrenceInstance,
} from '../../types/financeV3';
import { resolveAutomatedV3Status } from '../../utils/financeEngine';
import { getUserAccounts } from '../../services/accountService';
import {
  getUserCategories,
  createCategory,
  archiveCategory,
  ensureDefaultCategories,
} from '../../services/categoryService';
import {
  createPersonalTransaction,
  recordPartialPayment,
  cancelPersonalTransaction,
  getUserPersonalTransactions,
  getPersonalTransactionPayments,
} from '../../services/personalTransactionService';
import {
  executeInternalTransfer,
  getUserTransfers,
} from '../../services/transferService';
import {
  getCardInvoices,
  payCardInvoice,
  carryOverInvoiceBalance,
  calculateCardAvailableLimit,
} from '../../services/creditCardService';
import {
  getUserBudgetsWithProgress,
  createPersonalBudget,
  deletePersonalBudget,
} from '../../services/budgetService';
import {
  createPersonalRefund,
  recordRefundReceipt,
  getUserRefunds,
  getRefundReceipts,
} from '../../services/refundService';
import {
  getRecurrenceRules,
  createRecurrenceRule,
  updateRecurrenceRuleStatus,
  generateRecurrenceInstance,
  getRecurrenceInstances,
  getInstallmentContracts,
  createInstallmentContract,
  getInstallmentOccurrences,
  cancelInstallmentContract,
} from '../../services/recurrenceService';
import {
  formatCentsToBRL,
  parseBRLToCents,
  validatePositiveCents,
} from '../../utils/movementLedger';

interface PersonalFinanceViewV3Props {
  userId: string;
  isDemo?: boolean;
}

type MainTab =
  | 'transactions'
  | 'invoices'
  | 'transfers'
  | 'budgets'
  | 'refunds'
  | 'categories'
  | 'recurrences'
  | 'installments';

export const PersonalFinanceViewV3: React.FC<PersonalFinanceViewV3Props> = ({
  userId,
  isDemo = false,
}) => {
  const [activeTab, setActiveTab] = useState<MainTab>('transactions');
  const [selectedMonth, setSelectedMonth] = useState<CompetenceMonthString>(() => {
    const now = new Date();
    return `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  // Dados carregados
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<PersonalCategory[]>([]);
  const [transactions, setTransactions] = useState<PersonalTransaction[]>([]);
  const [invoices, setInvoices] = useState<CreditCardInvoice[]>([]);
  const [transfers, setTransfers] = useState<InternalAccountTransfer[]>([]);
  const [budgets, setBudgets] = useState<PersonalBudgetProgress[]>([]);
  const [refunds, setRefunds] = useState<PersonalRefund[]>([]);

  // Filtros de Transações
  const [filterType, setFilterType] = useState<'all' | 'income' | 'expense'>('all');
  const [filterStatus, setFilterStatus] = useState<'all' | PersonalTransactionStatus>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');

  // Modais
  const [isTxModalOpen, setIsTxModalOpen] = useState(false);
  const [txType, setTxType] = useState<PersonalTransactionType>('expense');
  const [txDesc, setTxDesc] = useState('');
  const [txAmount, setTxAmount] = useState('');
  const [txCategory, setTxCategory] = useState('');
  const [txAccount, setTxAccount] = useState('');
  const [txDate, setTxDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [txStatus, setTxStatus] = useState<PersonalTransactionStatus>('paid');
  const [txNotes, setTxNotes] = useState('');
  const [txIdempotencyKey, setTxIdempotencyKey] = useState('');
  const [txSubmitting, setTxSubmitting] = useState(false);

  // Modal Pagamento Parcial
  const [partialTx, setPartialTx] = useState<PersonalTransaction | null>(null);
  const [partialAmount, setPartialAmount] = useState('');
  const [partialAccount, setPartialAccount] = useState('');
  const [partialDate, setPartialDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [partialNotes, setPartialNotes] = useState('');
  const [partialIdempotencyKey, setPartialIdempotencyKey] = useState('');
  const [partialSubmitting, setPartialSubmitting] = useState(false);

  // Modal Transferência
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [xferSource, setXferSource] = useState('');
  const [xferDest, setXferDest] = useState('');
  const [xferAmount, setXferAmount] = useState('');
  const [xferDate, setXferDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [xferDesc, setXferDesc] = useState('');
  const [xferIdempotencyKey, setXferIdempotencyKey] = useState('');
  const [xferSubmitting, setXferSubmitting] = useState(false);

  // Modal Pagar Fatura
  const [payInvoiceModal, setPayInvoiceModal] = useState<CreditCardInvoice | null>(null);
  const [payInvSourceAcc, setPayInvSourceAcc] = useState('');
  const [payInvAmount, setPayInvAmount] = useState('');
  const [payInvDate, setPayInvDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payInvIdempotencyKey, setPayInvIdempotencyKey] = useState('');
  const [payInvSubmitting, setPayInvSubmitting] = useState(false);

  // Modal Orçamento
  const [isBudgetModalOpen, setIsBudgetModalOpen] = useState(false);
  const [budgetName, setBudgetName] = useState('');
  const [budgetCatIds, setBudgetCatIds] = useState<string[]>([]);
  const [budgetAmount, setBudgetAmount] = useState('');
  const [budgetSubmitting, setBudgetSubmitting] = useState(false);

  // Modal Reembolso
  const [isRefundModalOpen, setIsRefundModalOpen] = useState(false);
  const [refTxId, setRefTxId] = useState('');
  const [refDebtor, setRefDebtor] = useState('');
  const [refAmount, setRefAmount] = useState('');
  const [refDesc, setRefDesc] = useState('');
  const [refIdempotencyKey, setRefIdempotencyKey] = useState('');
  const [refSubmitting, setRefSubmitting] = useState(false);

  // Modal Receber Reembolso
  const [receiveRefundModal, setReceiveRefundModal] = useState<PersonalRefund | null>(null);
  const [receiveAmount, setReceiveAmount] = useState('');
  const [receiveAccount, setReceiveAccount] = useState('');
  const [receiveDate, setReceiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [receiveIdempotencyKey, setReceiveIdempotencyKey] = useState('');
  const [receiveSubmitting, setReceiveSubmitting] = useState(false);

  // Modal Nova Categoria
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [newCatType, setNewCatType] = useState<'income' | 'expense'>('expense');
  const [newCatColor, setNewCatColor] = useState('#2563EB');
  const [newCatSubmitting, setNewCatSubmitting] = useState(false);

  // Recorrências e Parcelamentos (Fase 9)
  const [recurrenceRules, setRecurrenceRules] = useState<RecurrenceRule[]>([]);
  const [installmentContracts, setInstallmentContracts] = useState<InstallmentContract[]>([]);
  const [expandedContractId, setExpandedContractId] = useState<string | null>(null);
  const [contractOccurrences, setContractOccurrences] = useState<Record<string, InstallmentOccurrence[]>>({});
  const [loadingOccurrences, setLoadingOccurrences] = useState<Record<string, boolean>>({});

  // Modal Recorrência / Fixos
  const [isRecurrenceModalOpen, setIsRecurrenceModalOpen] = useState(false);
  const [recTitle, setRecTitle] = useState('');
  const [recDesc, setRecDesc] = useState('');
  const [recType, setRecType] = useState<PersonalTransactionType>('expense');
  const [recNature, setRecNature] = useState<RecurrenceRuleNature>('fixed');
  const [recAmount, setRecAmount] = useState('');
  const [recFrequency, setRecFrequency] = useState<'monthly' | 'weekly' | 'yearly'>('monthly');
  const [recStartCompetence, setRecStartCompetence] = useState(() => selectedMonth);
  const [recDueDay, setRecDueDay] = useState(10);
  const [recCategory, setRecCategory] = useState('');
  const [recAccount, setRecAccount] = useState('');
  const [recGenerateInitial, setRecGenerateInitial] = useState(true);
  const [recSubmitting, setRecSubmitting] = useState(false);

  // Modal Parcelamento (incluindo parcelamentos já em andamento)
  const [isInstallmentModalOpen, setIsInstallmentModalOpen] = useState(false);
  const [instTitle, setInstTitle] = useState('');
  const [instAmount, setInstAmount] = useState('');
  const [instCount, setInstCount] = useState(2);
  const [instOngoing, setInstOngoing] = useState(false);
  const [instCurrentNumber, setInstCurrentNumber] = useState(2);
  const [instAmountMode, setInstAmountMode] = useState<'remaining' | 'total'>('remaining');
  const [instFundingSource, setInstFundingSource] = useState<InstallmentContractFundingSource>('credit_card');
  const [instCardAccount, setInstCardAccount] = useState('');
  const [instStartMonth, setInstStartMonth] = useState(() => selectedMonth);
  const [instDueDay, setInstDueDay] = useState(10);
  const [instSubmitting, setInstSubmitting] = useState(false);

  // Modal Cancelar Parcelamento
  const [cancelContractModal, setCancelContractModal] = useState<InstallmentContract | null>(null);
  const [cancelContractReason, setCancelContractReason] = useState('');
  const [cancelContractSubmitting, setCancelContractSubmitting] = useState(false);

  const showToast = (msg: string) => {
    setSuccessToast(msg);
    setTimeout(() => setSuccessToast(null), 4000);
  };

  // Carregamento principal de dados
  const loadAllData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 1. Contas
      const accList = await getUserAccounts(userId, true, isDemo);
      setAccounts(accList);

      // 2. Categorias (garante padrão inicial)
      const catList = await ensureDefaultCategories(userId, isDemo);
      setCategories(catList);

      // 3. Transações do Mês
      const txList = await getUserPersonalTransactions(
        userId,
        { competenceMonth: selectedMonth },
        isDemo
      );
      setTransactions(txList);

      // 4. Faturas de Cartão
      const cardAccounts = accList.filter((a) => a.type === 'credit');
      const allInvoices: CreditCardInvoice[] = [];
      for (const card of cardAccounts) {
        const invs = await getCardInvoices(card.id, userId, isDemo);
        allInvoices.push(...invs);
      }
      setInvoices(allInvoices);

      // 5. Transferências
      const xferList = await getUserTransfers(userId, isDemo);
      setTransfers(xferList);

      // 6. Orçamentos com Progresso
      const bgtList = await getUserBudgetsWithProgress(userId, selectedMonth, isDemo);
      setBudgets(bgtList);

      // 7. Reembolsos
      const refList = await getUserRefunds(userId, isDemo);
      setRefunds(refList);

      // 8. Recorrências e Parcelamentos (Fase 9)
      const [rulesList, contractsList] = await Promise.all([
        getRecurrenceRules({ userId }, isDemo),
        getInstallmentContracts({ userId }, isDemo),
      ]);
      setRecurrenceRules(rulesList);
      setInstallmentContracts(contractsList);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao carregar dados financeiros';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [userId, selectedMonth, isDemo]);

  useEffect(() => {
    loadAllData();
  }, [loadAllData]);

  // Indicadores e Métricas
  const totalBalanceCents = useMemo(() => {
    return accounts
      .filter((a) => !a.isArchived && a.type !== 'credit')
      .reduce((sum, a) => sum + (a.projectedBalanceCents || 0), 0);
  }, [accounts]);

  const monthIncomeCents = useMemo(() => {
    return transactions
      .filter((t) => t.type === 'income' && t.status === 'paid')
      .reduce((sum, t) => sum + t.amountCents, 0);
  }, [transactions]);

  const monthExpenseCents = useMemo(() => {
    return transactions
      .filter((t) => t.type === 'expense' && t.status === 'paid')
      .reduce((sum, t) => sum + t.amountCents, 0);
  }, [transactions]);

  const pendingExpenseCents = useMemo(() => {
    return transactions
      .filter((t) => t.type === 'expense' && (t.status === 'pending' || t.status === 'forecast' || t.status === 'partially_paid'))
      .reduce((sum, t) => sum + (t.remainingAmountCents ?? t.amountCents), 0);
  }, [transactions]);

  // Transações Filtradas
  const filteredTransactions = useMemo(() => {
    return transactions.filter((t) => {
      if (filterType !== 'all' && t.type !== filterType) return false;
      if (filterStatus !== 'all') {
        const autoKey = resolveAutomatedV3Status(t).key;
        if (filterStatus === ('overdue' as PersonalTransactionStatus)) {
          if (autoKey !== 'overdue') return false;
        } else if (t.status !== filterStatus) {
          return false;
        }
      }
      if (filterCategory !== 'all' && t.categoryId !== filterCategory) return false;
      return true;
    });
  }, [transactions, filterType, filterStatus, filterCategory]);

  // 1. Gravar Nova Transação (Receita ou Despesa)
  const handleCreateTransaction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!txDesc.trim()) {
      setModalError('Descrição é obrigatória.');
      return;
    }
    let cents = 0;
    try {
      cents = parseBRLToCents(txAmount);
      validatePositiveCents(cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setModalError(msg);
      return;
    }

    if (!txCategory) {
      setModalError('Selecione uma categoria.');
      return;
    }

    setTxSubmitting(true);
    setModalError(null);
    try {
      const activeKey =
        txIdempotencyKey ||
        `idem_ui_ptx_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!txIdempotencyKey) setTxIdempotencyKey(activeKey);

      const selectedCat = categories.find((c) => c.id === txCategory);
      await createPersonalTransaction(
        userId,
        {
          description: txDesc.trim(),
          amountCents: cents,
          type: txType,
          status: txStatus,
          categoryId: txCategory,
          categoryName: selectedCat?.name || 'Geral',
          accountId: txAccount || undefined,
          competenceDate: txDate,
          dueDate: txDate,
          paymentDate: txStatus === 'paid' ? txDate : undefined,
          notes: txNotes.trim() || undefined,
          idempotencyKey: activeKey,
        },
        isDemo
      );

      showToast(
        `${txType === 'income' ? 'Receita' : 'Despesa'} registrada com sucesso!`
      );
      setIsTxModalOpen(false);
      resetTxForm();
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao registrar transação';
      setModalError(msg);
    } finally {
      setTxSubmitting(false);
    }
  };

  const resetTxForm = () => {
    setModalError(null);
    setTxDesc('');
    setTxAmount('');
    setTxCategory('');
    setTxAccount('');
    setTxNotes('');
    setTxStatus('paid');
    setTxIdempotencyKey(
      `idem_ui_ptx_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    );
  };

  // 2. Amortização / Pagamento Parcial
  const handleExecutePartialPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!partialTx) return;

    let cents = 0;
    try {
      cents = parseBRLToCents(partialAmount);
      validatePositiveCents(cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setModalError(msg);
      return;
    }

    if (!partialAccount) {
      setModalError('Selecione a conta para débito/crédito.');
      return;
    }

    setPartialSubmitting(true);
    setModalError(null);
    try {
      const activeKey =
        partialIdempotencyKey ||
        `idem_ui_txpay_${partialTx.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!partialIdempotencyKey) setPartialIdempotencyKey(activeKey);

      await recordPartialPayment(
        partialTx.id,
        userId,
        {
          amountCents: cents,
          paymentDate: partialDate,
          accountId: partialAccount,
          notes: partialNotes.trim() || undefined,
          authorUid: userId,
          idempotencyKey: activeKey,
        },
        isDemo
      );

      showToast(`Amortização de ${formatCentsToBRL(cents)} registrada com sucesso!`);
      setPartialTx(null);
      setPartialAmount('');
      setPartialNotes('');
      setPartialIdempotencyKey('');
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha na amortização';
      setModalError(msg);
    } finally {
      setPartialSubmitting(false);
    }
  };

  // 3. Cancelamento de Transação
  const handleCancelTx = async (tx: PersonalTransaction) => {
    const reason = window.prompt(
      `Confirma o cancelamento da transação "${tx.description}"?\nInforme o motivo obrigatório:`
    );
    if (!reason || !reason.trim()) return;

    try {
      await cancelPersonalTransaction(tx.id, userId, reason.trim(), isDemo);
      showToast('Transação cancelada com sucesso.');
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao cancelar transação';
      setError(msg);
    }
  };

  // 4. Transferência entre Contas Próprias
  const handleExecuteTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!xferSource || !xferDest) {
      setModalError('Selecione conta de origem e conta de destino.');
      return;
    }
    if (xferSource === xferDest) {
      setModalError('Origem e destino não podem ser a mesma conta.');
      return;
    }

    let cents = 0;
    try {
      cents = parseBRLToCents(xferAmount);
      validatePositiveCents(cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setModalError(msg);
      return;
    }

    setXferSubmitting(true);
    setModalError(null);
    try {
      const activeKey =
        xferIdempotencyKey ||
        `idem_ui_xfer_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!xferIdempotencyKey) setXferIdempotencyKey(activeKey);

      await executeInternalTransfer(
        userId,
        {
          sourceAccountId: xferSource,
          destinationAccountId: xferDest,
          amountCents: cents,
          transferDate: xferDate,
          description: xferDesc.trim() || undefined,
          idempotencyKey: activeKey,
        },
        isDemo
      );

      showToast(`Transferência de ${formatCentsToBRL(cents)} executada com sucesso!`);
      setIsTransferModalOpen(false);
      setXferAmount('');
      setXferDesc('');
      setXferIdempotencyKey('');
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha na transferência';
      setModalError(msg);
    } finally {
      setXferSubmitting(false);
    }
  };

  // 5. Pagar Fatura de Cartão
  const handleExecutePayInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payInvoiceModal) return;
    if (!payInvSourceAcc) {
      setModalError('Selecione a conta corrente/carteira pagadora.');
      return;
    }

    let cents = 0;
    try {
      cents = parseBRLToCents(payInvAmount);
      validatePositiveCents(cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setModalError(msg);
      return;
    }

    setPayInvSubmitting(true);
    setModalError(null);
    try {
      const activeKey =
        payInvIdempotencyKey ||
        `idem_ui_invpay_${payInvoiceModal.accountId}_${payInvoiceModal.invoiceMonth}_${Date.now()}`;
      if (!payInvIdempotencyKey) setPayInvIdempotencyKey(activeKey);

      await payCardInvoice(
        {
          cardAccountId: payInvoiceModal.accountId,
          invoiceMonth: payInvoiceModal.invoiceMonth,
          sourceAccountId: payInvSourceAcc,
          amountPaidCents: cents,
          paymentDate: payInvDate,
          userId,
          idempotencyKey: activeKey,
        },
        isDemo
      );

      showToast(`Pagamento de fatura gravado: ${formatCentsToBRL(cents)} debitado na conta!`);
      setPayInvoiceModal(null);
      setPayInvAmount('');
      setPayInvIdempotencyKey('');
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha no pagamento da fatura';
      setModalError(msg);
    } finally {
      setPayInvSubmitting(false);
    }
  };

  // 6. Criar Orçamento
  const handleCreateBudget = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!budgetName.trim()) {
      setModalError('Nome do orçamento é obrigatório.');
      return;
    }
    if (budgetCatIds.length === 0) {
      setModalError('Selecione ao menos uma categoria para o orçamento.');
      return;
    }
    let cents = 0;
    try {
      cents = parseBRLToCents(budgetAmount);
      validatePositiveCents(cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setModalError(msg);
      return;
    }

    setBudgetSubmitting(true);
    setModalError(null);
    try {
      await createPersonalBudget(
        userId,
        {
          name: budgetName.trim(),
          categoryIds: budgetCatIds,
          competenceMonth: selectedMonth,
          plannedAmountCents: cents,
        },
        isDemo
      );

      showToast('Orçamento planejado com sucesso!');
      setIsBudgetModalOpen(false);
      setBudgetName('');
      setBudgetAmount('');
      setBudgetCatIds([]);
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao criar orçamento';
      setModalError(msg);
    } finally {
      setBudgetSubmitting(false);
    }
  };

  // 7. Criar Reembolso
  const handleCreateRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!refDebtor.trim()) {
      setModalError('Nome do devedor é obrigatório.');
      return;
    }
    if (!refTxId) {
      setModalError('Selecione a despesa original vinculada.');
      return;
    }
    let cents = 0;
    try {
      cents = parseBRLToCents(refAmount);
      validatePositiveCents(cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setModalError(msg);
      return;
    }

    setRefSubmitting(true);
    setModalError(null);
    try {
      const activeKey =
        refIdempotencyKey ||
        `idem_ui_ref_${userId}_${refTxId}_${Date.now()}`;
      if (!refIdempotencyKey) setRefIdempotencyKey(activeKey);

      await createPersonalRefund(
        userId,
        {
          originalTransactionId: refTxId,
          debtorName: refDebtor.trim(),
          amountDueCents: cents,
          description: refDesc.trim() || undefined,
          idempotencyKey: activeKey,
        },
        isDemo
      );

      showToast('Reembolso registrado com sucesso!');
      setIsRefundModalOpen(false);
      setRefDebtor('');
      setRefAmount('');
      setRefDesc('');
      setRefTxId('');
      setRefIdempotencyKey('');
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao registrar reembolso';
      setModalError(msg);
    } finally {
      setRefSubmitting(false);
    }
  };

  // 8. Receber Reembolso
  const handleExecuteReceiveRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!receiveRefundModal) return;
    if (!receiveAccount) {
      setModalError('Selecione a conta para recebimento do crédito.');
      return;
    }
    let cents = 0;
    try {
      cents = parseBRLToCents(receiveAmount);
      validatePositiveCents(cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setModalError(msg);
      return;
    }

    setReceiveSubmitting(true);
    setModalError(null);
    try {
      const activeKey =
        receiveIdempotencyKey ||
        `idem_ui_refrec_${receiveRefundModal.id}_${Date.now()}`;
      if (!receiveIdempotencyKey) setReceiveIdempotencyKey(activeKey);

      await recordRefundReceipt(
        userId,
        {
          refundId: receiveRefundModal.id,
          amountCents: cents,
          receiptDate: receiveDate,
          destinationAccountId: receiveAccount,
          authorUid: userId,
          idempotencyKey: activeKey,
        },
        isDemo
      );

      showToast(`Recebimento de reembolso creditado: ${formatCentsToBRL(cents)}!`);
      setReceiveRefundModal(null);
      setReceiveAmount('');
      setReceiveIdempotencyKey('');
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao receber reembolso';
      setModalError(msg);
    } finally {
      setReceiveSubmitting(false);
    }
  };

  // 9. Criar Categoria
  const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatName.trim()) {
      setModalError('Nome da categoria é obrigatório.');
      return;
    }

    setNewCatSubmitting(true);
    setModalError(null);
    try {
      await createCategory(
        userId,
        {
          name: newCatName.trim(),
          type: newCatType,
          color: newCatColor,
        },
        isDemo
      );

      showToast('Categoria criada com sucesso!');
      setIsCategoryModalOpen(false);
      setNewCatName('');
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao criar categoria';
      setModalError(msg);
    } finally {
      setNewCatSubmitting(false);
    }
  };

  // 10. Criar Regra de Recorrência ou Lançamento Fixo
  const handleCreateRecurrence = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recTitle.trim()) {
      setModalError('Título da recorrência é obrigatório.');
      return;
    }
    let cents = 0;
    try {
      cents = parseBRLToCents(recAmount);
      validatePositiveCents(cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setModalError(msg);
      return;
    }

    setRecSubmitting(true);
    setModalError(null);
    try {
      const idempotencyKey = `idem_ui_rec_${userId}_${Date.now()}`;
      const res = await createRecurrenceRule(
        {
          scope: 'personal',
          userId,
          title: recTitle.trim(),
          description: recDesc.trim() || undefined,
          type: recType,
          nature: recNature,
          amountCents: cents,
          frequency: recFrequency,
          startCompetence: recStartCompetence,
          dueDay: Number(recDueDay),
          categoryId: recCategory || undefined,
          defaultAccountId: recAccount || undefined,
          idempotencyKey,
        },
        isDemo
      );

      if (recGenerateInitial && res.rule?.id) {
        await generateRecurrenceInstance(
          { ruleId: res.rule.id, competenceMonth: recStartCompetence },
          isDemo
        );
      }

      showToast(
        recGenerateInitial
          ? `Regra "${recTitle.trim()}" criada e lançamento de ${recStartCompetence} gerado!`
          : `Regra "${recTitle.trim()}" criada com sucesso!`
      );
      setIsRecurrenceModalOpen(false);
      setRecTitle('');
      setRecDesc('');
      setRecType('expense');
      setRecNature('fixed');
      setRecAmount('');
      setRecDueDay(10);
      setRecCategory('');
      setRecAccount('');
      setRecGenerateInitial(true);
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao criar recorrência';
      setModalError(msg);
    } finally {
      setRecSubmitting(false);
    }
  };

  // 11. Alterar Status de Recorrência (Pausar / Reativar)
  const handleToggleRecurrenceStatus = async (ruleId: string, currentStatus: string) => {
    try {
      const nextStatus = currentStatus === 'active' ? 'paused' : 'active';
      await updateRecurrenceRuleStatus({ ruleId, status: nextStatus }, isDemo);
      showToast(`Recorrência ${nextStatus === 'active' ? 'reativada' : 'pausada'} com sucesso!`);
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao alterar status da recorrência';
      setError(msg);
    }
  };

  // 12. Gerar Instância do Mês Atual
  const handleGenerateRecurrenceInstance = async (ruleId: string) => {
    try {
      const res = await generateRecurrenceInstance({ ruleId, competenceMonth: selectedMonth }, isDemo);
      showToast(
        res.isIdempotentReplay
          ? `O lançamento de ${selectedMonth} para esta regra já havia sido gerado.`
          : `Lançamento da competência ${selectedMonth} materializado em Receitas & Despesas!`
      );
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao gerar instância';
      setError(msg);
    }
  };

  // 13. Cancelar Recorrência Definitivamente
  const handleCancelRecurrenceRule = async (ruleId: string) => {
    try {
      await updateRecurrenceRuleStatus({ ruleId, status: 'cancelled' }, isDemo);
      showToast('Recorrência cancelada definitivamente.');
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao cancelar recorrência';
      setError(msg);
    }
  };

  // 14. Criar Contrato de Parcelamento (Novo ou Em Andamento)
  const handleCreateInstallment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!instTitle.trim()) {
      setModalError('Título do parcelamento é obrigatório.');
      return;
    }
    if (instFundingSource === 'credit_card' && !instCardAccount) {
      setModalError('Selecione o cartão de crédito emissor.');
      return;
    }
    let cents = 0;
    try {
      cents = parseBRLToCents(instAmount);
      validatePositiveCents(cents);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Valor inválido';
      setModalError(msg);
      return;
    }

    const totalCount = Number(instCount);
    const initialInstallmentNumber = instOngoing ? Number(instCurrentNumber) : 1;
    if (
      !Number.isInteger(initialInstallmentNumber) ||
      initialInstallmentNumber < 1 ||
      initialInstallmentNumber > totalCount
    ) {
      setModalError(`A parcela inicial deve estar entre 1 e ${totalCount}.`);
      return;
    }

    const projectedCount = totalCount - initialInstallmentNumber + 1;
    let totalContractAmountCents = cents;
    let remainingAmountCents: CentsInteger | undefined = undefined;

    if (instOngoing && initialInstallmentNumber > 1) {
      if (instAmountMode === 'remaining') {
        remainingAmountCents = cents;
        totalContractAmountCents = Math.round((cents / projectedCount) * totalCount);
      } else {
        totalContractAmountCents = cents;
        remainingAmountCents = Math.round((cents / totalCount) * projectedCount);
      }
    }

    setInstSubmitting(true);
    setModalError(null);
    try {
      const idempotencyKey = `idem_ui_inst_${userId}_${Date.now()}`;
      await createInstallmentContract(
        {
          scope: 'personal',
          userId,
          title: instTitle.trim(),
          totalContractAmountCents,
          remainingAmountCents,
          totalInstallmentsCount: totalCount,
          initialInstallmentNumber,
          fundingSource: instFundingSource,
          sourceCardAccountId: instFundingSource === 'credit_card' ? instCardAccount : undefined,
          startCompetenceMonth: instStartMonth,
          dueDay: Number(instDueDay),
          idempotencyKey,
        },
        isDemo
      );
      showToast(
        instOngoing && initialInstallmentNumber > 1
          ? `Parcelamento em andamento registrado (${initialInstallmentNumber}/${totalCount} até ${totalCount}/${totalCount})!`
          : `Parcelamento em ${totalCount}x registrado com sucesso!`
      );
      setIsInstallmentModalOpen(false);
      setInstTitle('');
      setInstAmount('');
      setInstCount(2);
      setInstOngoing(false);
      setInstCurrentNumber(2);
      setInstAmountMode('remaining');
      setInstCardAccount('');
      setInstDueDay(10);
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao registrar parcelamento';
      setModalError(msg);
    } finally {
      setInstSubmitting(false);
    }
  };

  // 15. Alternar Exibição de Parcelas de um Contrato
  const handleToggleContractOccurrences = async (contractId: string) => {
    if (expandedContractId === contractId) {
      setExpandedContractId(null);
      return;
    }
    setExpandedContractId(contractId);
    if (!contractOccurrences[contractId]) {
      setLoadingOccurrences((prev) => ({ ...prev, [contractId]: true }));
      try {
        const occs = await getInstallmentOccurrences(contractId, isDemo);
        setContractOccurrences((prev) => ({ ...prev, [contractId]: occs }));
      } catch (err: unknown) {
        console.warn('Erro ao carregar parcelas:', err);
      } finally {
        setLoadingOccurrences((prev) => ({ ...prev, [contractId]: false }));
      }
    }
  };

  // 16. Confirmar Cancelamento Antecipado de Parcelamento
  const handleCancelInstallmentContractSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelContractModal) return;

    setCancelContractSubmitting(true);
    setModalError(null);
    try {
      const res = await cancelInstallmentContract(
        {
          contractId: cancelContractModal.id,
          cancellationReason: cancelContractReason.trim() || 'Cancelamento antecipado via interface',
        },
        isDemo
      );
      showToast(`Contrato cancelado! ${res.cancelledCount} parcelas futuras canceladas.`);
      setCancelContractModal(null);
      setCancelContractReason('');
      setContractOccurrences((prev) => {
        const next = { ...prev };
        delete next[cancelContractModal.id];
        return next;
      });
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao cancelar contrato';
      setModalError(msg);
    } finally {
      setCancelContractSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Toast de Sucesso */}
      {successToast && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 bg-emerald-600 text-white rounded-xl shadow-xl transition-all">
          <CheckCircle2 className="w-5 h-5 shrink-0" />
          <span className="text-sm font-medium">{successToast}</span>
        </div>
      )}

      {/* Alerta de Erro */}
      {error && (
        <div className="flex items-center justify-between p-4 bg-rose-950/60 border border-rose-800/80 text-rose-300 rounded-xl">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 shrink-0 text-rose-400" />
            <span className="text-sm font-medium">{error}</span>
          </div>
          <button
            onClick={() => setError(null)}
            className="text-rose-400 hover:text-rose-200 text-sm font-bold ml-4 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* Header Principal do Financeiro Individual */}
      <div className="bg-slate-800/90 rounded-2xl p-6 shadow-sm border border-slate-700/80 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 text-xs font-semibold tracking-wider uppercase bg-blue-950/60 text-blue-300 rounded-md border border-blue-800/60">
              Financeiro Individual v3.1
            </span>
            {isDemo && (
              <span className="px-2.5 py-0.5 text-xs font-semibold tracking-wider uppercase bg-amber-950/60 text-amber-300 rounded-md border border-amber-800/60">
                Modo Demonstração (Isolado)
              </span>
            )}
          </div>
          <h1 className="text-2xl font-black text-white mt-1">
            Gestão Financeira Pessoal
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Controle independente de receitas, despesas, faturas, transferências, orçamentos e reembolsos.
          </p>
        </div>

        {/* Seletor de Mês e Botão de Ação Rápida */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 rounded-xl text-xs font-semibold text-slate-300 border border-slate-700">
            <Calendar className="w-4 h-4 text-slate-400" />
            <input
              type="month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value as CompetenceMonthString)}
              className="bg-transparent border-0 focus:outline-none cursor-pointer text-white font-bold"
            />
          </div>

          <button
            onClick={() => {
              setTxType('expense');
              resetTxForm();
              setIsTxModalOpen(true);
            }}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-xl shadow-xs transition-all cursor-pointer"
          >
            <ArrowUpRight className="w-4 h-4" />
            Nova Despesa
          </button>

          <button
            onClick={() => {
              setTxType('income');
              resetTxForm();
              setIsTxModalOpen(true);
            }}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-xl shadow-xs transition-all cursor-pointer"
          >
            <ArrowDownLeft className="w-4 h-4" />
            Nova Receita
          </button>
        </div>
      </div>

      {/* Cards de Métricas Consolidadas do Mês */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Saldo Líquido Consolidado */}
        <div className="bg-slate-800/90 p-5 rounded-2xl border border-slate-700/80 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Saldo Consolidado
            </span>
            <div className="p-2 bg-blue-950/60 text-blue-400 border border-blue-800/50 rounded-xl">
              <DollarSign className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-black text-white">
            {formatCentsToBRL(totalBalanceCents)}
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            Contas correntes, poupanças e carteiras
          </div>
        </div>

        {/* Receitas Efetivadas */}
        <div className="bg-slate-800/90 p-5 rounded-2xl border border-slate-700/80 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Receitas do Mês
            </span>
            <div className="p-2 bg-emerald-950/60 text-emerald-400 border border-emerald-800/50 rounded-xl">
              <ArrowDownLeft className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-black text-emerald-400">
            {formatCentsToBRL(monthIncomeCents)}
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            Total recebido e creditado em caixa
          </div>
        </div>

        {/* Despesas Reconhecidas */}
        <div className="bg-slate-800/90 p-5 rounded-2xl border border-slate-700/80 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Despesas Realizadas
            </span>
            <div className="p-2 bg-rose-950/60 text-rose-400 border border-rose-800/50 rounded-xl">
              <ArrowUpRight className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-black text-rose-400">
            {formatCentsToBRL(monthExpenseCents)}
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            Pagas via conta ou cartão na competência
          </div>
        </div>

        {/* Despesas Pendentes */}
        <div className="bg-slate-800/90 p-5 rounded-2xl border border-slate-700/80 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Contas a Pagar
            </span>
            <div className="p-2 bg-amber-950/60 text-amber-400 border border-amber-800/50 rounded-xl">
              <Clock className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-black text-amber-400">
            {formatCentsToBRL(pendingExpenseCents)}
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            Obrigações pendentes ou parciais
          </div>
        </div>
      </div>

      {/* Navegação por Abas Funcionais */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700/80 pb-2">
        <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-800 rounded-xl border border-slate-700">
          <button
            onClick={() => setActiveTab('transactions')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
              activeTab === 'transactions'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            Receitas & Despesas ({transactions.length})
          </button>

          <button
            onClick={() => setActiveTab('invoices')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
              activeTab === 'invoices'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <CreditCard className="w-3.5 h-3.5" />
            Cartões & Faturas ({invoices.length})
          </button>

          <button
            onClick={() => setActiveTab('transfers')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
              activeTab === 'transfers'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <ArrowLeftRight className="w-3.5 h-3.5" />
            Transferências ({transfers.length})
          </button>

          <button
            onClick={() => setActiveTab('budgets')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
              activeTab === 'budgets'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Target className="w-3.5 h-3.5" />
            Orçamentos ({budgets.length})
          </button>

          <button
            onClick={() => setActiveTab('refunds')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
              activeTab === 'refunds'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reembolsos ({refunds.length})
          </button>

          <button
            onClick={() => setActiveTab('categories')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
              activeTab === 'categories'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Tag className="w-3.5 h-3.5" />
            Categorias ({categories.length})
          </button>

          <button
            onClick={() => setActiveTab('recurrences')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
              activeTab === 'recurrences'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Repeat className="w-3.5 h-3.5" />
            Fixos & Recorrentes ({recurrenceRules.length})
          </button>

          <button
            onClick={() => setActiveTab('installments')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
              activeTab === 'installments'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Parcelamentos ({installmentContracts.length})
          </button>
        </div>

        <button
          onClick={loadAllData}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-white px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Atualizar Dados
        </button>
      </div>

      {/* ABA 1: TRANSAÇÕES (RECEITAS & DESPESAS) */}
      {activeTab === 'transactions' && (
        <div className="space-y-4">
          {/* Barra de Filtros */}
          <div className="bg-slate-800/90 p-4 rounded-xl border border-slate-700/80 shadow-xs flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Filtros:
              </span>
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value as any)}
                className="px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 text-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="all">Todos os Tipos</option>
                <option value="income">Apenas Receitas</option>
                <option value="expense">Apenas Despesas</option>
              </select>

              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as any)}
                className="px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 text-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="all">Todos os Status</option>
                <option value="paid">Pagas / Recebidas</option>
                <option value="pending">Pendentes / A Vencer</option>
                <option value="overdue">Vencidas</option>
                <option value="partially_paid">Parcialmente Pagas</option>
                <option value="forecast">Previstas</option>
                <option value="cancelled">Canceladas</option>
              </select>

              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 text-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="all">Todas as Categorias</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="text-xs text-slate-400 font-medium">
              Exibindo <strong className="text-white">{filteredTransactions.length}</strong> lançamento(s)
            </div>
          </div>

          {/* Listagem de Transações */}
          {loading ? (
            <div className="text-center py-12 bg-slate-800/90 rounded-xl border border-slate-700/80">
              <RefreshCw className="w-6 h-6 animate-spin text-indigo-400 mx-auto" />
              <p className="text-xs text-slate-400 mt-2">Carregando transações...</p>
            </div>
          ) : filteredTransactions.length === 0 ? (
            <div className="text-center py-12 bg-slate-800/90 rounded-2xl border border-dashed border-slate-700/80 p-8">
              <FileText className="w-10 h-10 text-slate-500 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-200">
                Nenhum lançamento encontrado
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                Utilize os botões "Nova Receita" ou "Nova Despesa" acima para registrar transações.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredTransactions.map((tx) => {
                const isIncome = tx.type === 'income';
                const statusInfo = resolveAutomatedV3Status(tx);
                const isPaid = statusInfo.key === 'paid';
                const isPartiallyPaid = statusInfo.key === 'partially_paid';
                const isCancelled = statusInfo.key === 'cancelled';

                return (
                  <div
                    key={tx.id}
                    className={`p-4 rounded-xl border transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                      isCancelled
                        ? 'bg-slate-900/40 border-slate-700/60 opacity-60'
                        : 'bg-slate-900/70 border-slate-700/70 hover:border-slate-600'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                          isCancelled
                            ? 'bg-slate-800 text-slate-400 border border-slate-700'
                            : isIncome
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                            : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                        }`}
                      >
                        {isCancelled ? (
                          <Ban className="w-4 h-4" />
                        ) : isIncome ? (
                          <ArrowDownLeft className="w-4 h-4" />
                        ) : (
                          <ArrowUpRight className="w-4 h-4" />
                        )}
                      </div>

                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold text-white text-sm">
                            {tx.description}
                          </span>
                          <span className="px-2 py-0.5 text-[10px] font-semibold bg-slate-800 text-slate-300 border border-slate-700 rounded-md">
                            {tx.categoryName}
                          </span>
                          <span
                            className={`px-2 py-0.5 text-[10px] font-bold rounded-md ${statusInfo.badgeClass}`}
                          >
                            {statusInfo.label}
                          </span>
                          {tx.invoiceMonth && (
                            <span className="px-2 py-0.5 text-[10px] font-medium bg-purple-500/15 text-purple-300 border border-purple-500/30 rounded-md">
                              Fatura: {tx.invoiceMonth}
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400 mt-1">
                          <span>Data: {tx.competenceDate}</span>
                          {tx.dueDate && tx.dueDate !== tx.competenceDate && (
                            <span>• Vence: {tx.dueDate}</span>
                          )}
                          {isPartiallyPaid && (
                            <span className="text-amber-300 font-semibold">
                              • Amortizado: {formatCentsToBRL(tx.paidAmountCents || 0)} (Resta:{' '}
                              {formatCentsToBRL(tx.remainingAmountCents || 0)})
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-700/60">
                      <div className="text-right">
                        <span
                          className={`text-base font-black font-mono ${
                            isIncome ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {isIncome ? '+ ' : '- '}
                          {formatCentsToBRL(tx.amountCents)}
                        </span>
                      </div>

                      {/* Botões de Ação */}
                      <div className="flex items-center gap-1.5">
                        {!isPaid && !isCancelled && (
                          <button
                            onClick={() => {
                              setModalError(null);
                              setPartialTx(tx);
                              setPartialAmount('');
                              setPartialNotes('');
                              setPartialAccount(tx.accountId || '');
                            }}
                            className="px-2.5 py-1 text-xs font-semibold bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 hover:bg-indigo-500/25 rounded-lg transition-all cursor-pointer"
                            title="Registrar pagamento ou recebimento parcial"
                          >
                            Amortizar
                          </button>
                        )}

                        {!isCancelled && (
                          <button
                            onClick={() => handleCancelTx(tx)}
                            className="px-2.5 py-1 text-xs font-semibold text-rose-300 bg-rose-500/15 border border-rose-500/30 hover:bg-rose-500/25 rounded-lg transition-all cursor-pointer"
                            title="Cancelar lançamento"
                          >
                            Cancelar
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ABA 2: CARTÕES & FATURAS */}
      {activeTab === 'invoices' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-white">
                Faturas de Cartões de Crédito
              </h2>
              <p className="text-xs text-slate-400">
                Compras alocadas e pagamentos de fatura sem dupla contagem contábil.
              </p>
            </div>
          </div>

          {invoices.length === 0 ? (
            <div className="text-center py-12 bg-slate-800/90 rounded-2xl border border-dashed border-slate-700/80 p-8">
              <CreditCard className="w-10 h-10 text-slate-500 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-200">
                Nenhuma fatura encontrada
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                Cadastre um cartão de crédito na aba de Contas e registre compras no cartão para gerar faturas.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {invoices.map((inv) => {
                const card = accounts.find((a) => a.id === inv.accountId);
                const isPaid = inv.invoiceStatus === 'paid';
                const isCarriedOver = inv.invoiceStatus === 'carried_over';
                const isSettled = isPaid || isCarriedOver;
                const invStatusLabel =
                  inv.invoiceStatus === 'paid'
                    ? 'Paga'
                    : inv.invoiceStatus === 'carried_over'
                    ? 'Saldo Transportado'
                    : inv.invoiceStatus === 'partially_paid'
                    ? 'Parcialmente Paga'
                    : inv.invoiceStatus === 'closed'
                    ? 'Fechada'
                    : inv.invoiceStatus === 'overdue'
                    ? 'Vencida'
                    : 'Aberta';

                return (
                  <div
                    key={`${inv.accountId}-${inv.invoiceMonth}`}
                    className="bg-slate-800/90 rounded-2xl p-5 border border-slate-700/80 shadow-sm flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2.5">
                          <div className="p-2 bg-purple-500/15 text-purple-300 border border-purple-500/30 rounded-xl">
                            <CreditCard className="w-5 h-5" />
                          </div>
                          <div>
                            <h3 className="font-bold text-white text-sm">
                              {card?.name || 'Cartão de Crédito'}
                            </h3>
                            <span className="text-xs text-slate-400">
                              Fatura {inv.invoiceMonth}
                            </span>
                          </div>
                        </div>

                        <span
                          className={`px-2 py-0.5 text-[10px] font-bold rounded-md ${
                            isPaid
                              ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                              : isCarriedOver
                              ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                              : inv.invoiceStatus === 'partially_paid'
                              ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                              : inv.invoiceStatus === 'overdue'
                              ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                              : 'bg-purple-500/15 text-purple-300 border border-purple-500/30'
                          }`}
                        >
                          {invStatusLabel}
                        </span>
                      </div>

                      {/* Valores da Fatura */}
                      <div className="mt-4 pt-3 border-t border-slate-700/70 space-y-1.5 text-xs">
                        <div className="flex justify-between text-slate-400">
                          <span>Compras do período:</span>
                          <span className="font-semibold text-white font-mono">
                            {formatCentsToBRL(inv.totalPurchasesAmountCents)}
                          </span>
                        </div>
                        {inv.carriedOverBalanceCents > 0 && (
                          <div className="flex justify-between text-amber-300 font-medium">
                            <span>Saldo rotativo transportado:</span>
                            <span className="font-mono">{formatCentsToBRL(inv.carriedOverBalanceCents)}</span>
                          </div>
                        )}
                        {inv.interestAndFeesCents > 0 && (
                          <div className="flex justify-between text-rose-400 font-medium">
                            <span>Juros e encargos:</span>
                            <span className="font-mono">{formatCentsToBRL(inv.interestAndFeesCents)}</span>
                          </div>
                        )}
                        <div className="flex justify-between text-slate-400">
                          <span>Total pago:</span>
                          <span className="font-semibold text-emerald-400 font-mono">
                            {formatCentsToBRL(inv.totalPaidAmountCents)}
                          </span>
                        </div>
                        <div className="flex justify-between text-sm font-bold pt-2 border-t border-slate-700/70">
                          <span className="text-slate-200">Saldo Restante:</span>
                          <span className={`font-mono ${inv.remainingBalanceCents > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                            {formatCentsToBRL(inv.remainingBalanceCents)}
                          </span>
                        </div>
                      </div>

                      <div className="text-[11px] text-slate-400 mt-3">
                        Vencimento: <strong className="text-slate-200">{inv.dueDate}</strong> • Fechamento: {inv.closingDate}
                      </div>
                    </div>

                    {/* Botão Pagar Fatura */}
                    <div className="mt-4 pt-3 border-t border-slate-700/70 flex items-center gap-2">
                      {!isSettled && (
                        <button
                          onClick={() => {
                            setModalError(null);
                            setPayInvoiceModal(inv);
                            setPayInvAmount('');
                            setPayInvSourceAcc('');
                          }}
                          className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl transition-all shadow-xs cursor-pointer"
                        >
                          Pagar Fatura
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ABA 3: TRANSFERÊNCIAS */}
      {activeTab === 'transfers' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-white">
                Transferências entre Contas Próprias
              </h2>
              <p className="text-xs text-slate-400">
                Movimentação interna entre contas do usuário sem afetar receita ou despesa.
              </p>
            </div>

            <button
              onClick={() => {
                setModalError(null);
                setIsTransferModalOpen(true);
              }}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-xs transition-all cursor-pointer"
            >
              <ArrowLeftRight className="w-4 h-4" />
              Nova Transferência
            </button>
          </div>

          {transfers.length === 0 ? (
            <div className="text-center py-12 bg-slate-800/90 rounded-2xl border border-dashed border-slate-700/80 p-8">
              <ArrowLeftRight className="w-10 h-10 text-slate-500 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-200">
                Nenhuma transferência realizada
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                Transfira recursos entre suas contas correntes e carteiras de forma atômica e rastreável.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {transfers.map((xfer) => {
                const srcAcc = accounts.find((a) => a.id === xfer.sourceAccountId);
                const dstAcc = accounts.find((a) => a.id === xfer.destinationAccountId);

                return (
                  <div
                    key={xfer.id}
                    className="p-4 bg-slate-800/90 rounded-xl border border-slate-700/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 flex items-center justify-center shrink-0">
                        <ArrowLeftRight className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="text-sm font-bold text-white">
                          {xfer.description}
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5 flex flex-wrap items-center gap-2">
                          <span>
                            De: <strong className="text-slate-200">{srcAcc?.name || xfer.sourceAccountId}</strong>
                          </span>
                          <span>→</span>
                          <span>
                            Para: <strong className="text-slate-200">{dstAcc?.name || xfer.destinationAccountId}</strong>
                          </span>
                          <span>• {xfer.transferDate}</span>
                        </div>
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="text-base font-black text-white font-mono">
                        {formatCentsToBRL(xfer.amountCents)}
                      </div>
                      <span className="text-[10px] text-slate-400 uppercase font-semibold">
                        Invariante no Saldo Geral
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ABA 4: ORÇAMENTOS */}
      {activeTab === 'budgets' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-white">
                Orçamentos Planejados ({selectedMonth})
              </h2>
              <p className="text-xs text-slate-400">
                Acompanhamento de consumo derivado das despesas efetivas da competência.
              </p>
            </div>

            <button
              onClick={() => {
                setModalError(null);
                setIsBudgetModalOpen(true);
              }}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-xs transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Novo Orçamento
            </button>
          </div>

          {budgets.length === 0 ? (
            <div className="text-center py-12 bg-slate-800/90 rounded-2xl border border-dashed border-slate-700/80 p-8">
              <Target className="w-10 h-10 text-slate-500 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-200">
                Nenhum orçamento definido para este mês
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                Defina limites de gastos por categoria para controlar suas finanças planejadas.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {budgets.map((b) => {
                const isExceeded = b.status === 'exceeded';
                const isWarning = b.status === 'warning';

                return (
                  <div
                    key={b.id}
                    className="bg-slate-800/90 rounded-2xl p-5 border border-slate-700/80 shadow-sm flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2.5">
                          <div className="p-2 bg-blue-950/60 text-blue-400 border border-blue-800/50 rounded-xl">
                            <Target className="w-5 h-5" />
                          </div>
                          <div>
                            <h3 className="font-bold text-white text-sm">
                              {b.name}
                            </h3>
                            <span className="text-[11px] text-slate-400">
                              {b.categoryIds.length} categoria(s) vinculada(s)
                            </span>
                          </div>
                        </div>

                        <span
                          className={`px-2 py-0.5 text-[10px] font-bold rounded-md ${
                            isExceeded
                              ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                              : isWarning
                              ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                              : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                          }`}
                        >
                          {b.percentageUsed}%
                        </span>
                      </div>

                      {/* Barra de Progresso */}
                      <div className="mt-4">
                        <div className="h-2 w-full bg-slate-900 rounded-full overflow-hidden border border-slate-700/60">
                          <div
                            className={`h-full rounded-full transition-all ${
                              isExceeded
                                ? 'bg-rose-500'
                                : isWarning
                                ? 'bg-amber-500'
                                : 'bg-emerald-500'
                            }`}
                            style={{ width: `${Math.min(100, b.percentageUsed)}%` }}
                          />
                        </div>
                      </div>

                      {/* Valores: 3 indicadores distintos (Realizado, Comprometido, Previsto) */}
                      <div className="mt-4 pt-3 border-t border-slate-700/70 space-y-1 text-xs">
                        <div className="flex justify-between text-slate-400">
                          <span>Planejado:</span>
                          <span className="font-semibold text-white font-mono">
                            {formatCentsToBRL(b.plannedAmountCents)}
                          </span>
                        </div>
                        <div className="flex justify-between text-slate-400">
                          <span>Realizado (Pago):</span>
                          <span className="font-semibold text-rose-400 font-mono">
                            {formatCentsToBRL(b.realizedAmountCents ?? b.spentAmountCents)}
                          </span>
                        </div>
                        <div className="flex justify-between text-slate-400">
                          <span>Comprometido (Pendente):</span>
                          <span className="font-semibold text-amber-400 font-mono">
                            {formatCentsToBRL(b.committedAmountCents ?? 0)}
                          </span>
                        </div>
                        <div className="flex justify-between text-slate-400">
                          <span>Previsto (Projeção Total):</span>
                          <span className="font-semibold text-indigo-400 font-mono">
                            {formatCentsToBRL(b.forecastedAmountCents ?? b.spentAmountCents)} ({b.percentageForecasted ?? b.percentageUsed}%)
                          </span>
                        </div>
                        <div className="flex justify-between text-xs font-bold pt-1.5 border-t border-slate-700/70">
                          <span className="text-slate-200">Saldo Disponível (Real):</span>
                          <span className={`font-mono ${b.remainingAmountCents < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                            {formatCentsToBRL(b.remainingAmountCents)}
                          </span>
                        </div>
                        <div className="flex justify-between text-[11px] font-medium text-slate-400">
                          <span>Saldo Projetado Final:</span>
                          <span className={`font-mono ${(b.projectedRemainingAmountCents ?? b.remainingAmountCents) < 0 ? 'text-rose-400' : 'text-slate-200'}`}>
                            {formatCentsToBRL(b.projectedRemainingAmountCents ?? b.remainingAmountCents)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ABA 5: REEMBOLSOS */}
      {activeTab === 'refunds' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-white">
                Reembolsos Vinculados a Despesas
              </h2>
              <p className="text-xs text-slate-400">
                Controle de valores antecipados com crédito em caixa no recebimento.
              </p>
            </div>

            <button
              onClick={() => {
                setModalError(null);
                setIsRefundModalOpen(true);
              }}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-xs transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Novo Reembolso
            </button>
          </div>

          {refunds.length === 0 ? (
            <div className="text-center py-12 bg-slate-800/90 rounded-2xl border border-dashed border-slate-700/80 p-8">
              <RotateCcw className="w-10 h-10 text-slate-500 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-200">
                Nenhum reembolso cadastrado
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                Vincule expectativas de devolução a despesas pagas por você para recompor seu caixa quando receber.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {refunds.map((ref) => {
                const isReceived = ref.status === 'received';

                return (
                  <div
                    key={ref.id}
                    className="p-4 bg-slate-800/90 rounded-xl border border-slate-700/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-purple-500/15 text-purple-300 border border-purple-500/30 flex items-center justify-center shrink-0">
                        <RotateCcw className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="text-sm font-bold text-white">
                          {ref.description} (Devedor: <strong className="text-indigo-300">{ref.debtorName}</strong>)
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          Status: <strong className="text-slate-200">{ref.status === 'received' ? 'Recebido' : ref.status === 'partially_received' ? 'Parcialmente Recebido' : 'A Receber'}</strong> • Recebido:{' '}
                          {formatCentsToBRL(ref.amountReceivedCents)} de {formatCentsToBRL(ref.amountDueCents)}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
                      <div className="text-right">
                        <div className="text-sm font-black text-white font-mono">
                          Resta: {formatCentsToBRL(ref.remainingAmountCents)}
                        </div>
                      </div>

                      {!isReceived && (
                        <button
                          onClick={() => {
                            setModalError(null);
                            setReceiveRefundModal(ref);
                            setReceiveAmount('');
                            setReceiveAccount('');
                          }}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg shadow-xs transition-all cursor-pointer"
                        >
                          Receber
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ABA 6: CATEGORIAS */}
      {activeTab === 'categories' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-white">
                Categorias Individuais
              </h2>
              <p className="text-xs text-slate-400">
                Classificação própria para receitas e despesas com suporte a arquivamento seguro.
              </p>
            </div>

            <button
              onClick={() => {
                setModalError(null);
                setIsCategoryModalOpen(true);
              }}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-xs transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Nova Categoria
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {categories.map((cat) => (
              <div
                key={cat.id}
                className={`p-3.5 rounded-xl border bg-slate-800/90 border-slate-700/80 flex items-center justify-between gap-2 shadow-xs ${
                  cat.isArchived ? 'opacity-50 bg-slate-800' : 'border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="w-4 h-4 rounded-full shrink-0"
                    style={{ backgroundColor: cat.color || '#2563EB' }}
                  />
                  <div>
                    <div className="text-xs font-bold text-white leading-tight">
                      {cat.name}
                    </div>
                    <span className="text-[10px] text-slate-400 capitalize">
                      {cat.type === 'income' ? 'Receita' : 'Despesa'}
                    </span>
                  </div>
                </div>

                <button
                  onClick={async () => {
                    const nextState = !cat.isArchived;
                    await archiveCategory(cat.id, userId, nextState, isDemo);
                    showToast(`Categoria ${nextState ? 'arquivada' : 'ativada'}.`);
                    await loadAllData();
                  }}
                  className="text-[11px] text-slate-300 hover:text-white px-2 py-1 rounded bg-slate-900 hover:bg-slate-700 border border-slate-700 cursor-pointer"
                >
                  {cat.isArchived ? 'Desarquivar' : 'Arquivar'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ABA 7: FIXOS & RECORRENTES */}
      {activeTab === 'recurrences' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-white">
                Lançamentos Fixos & Recorrentes
              </h2>
              <p className="text-xs text-slate-400">
                Receitas ou despesas fixas (ex: salário, aluguel) e assinaturas recorrentes com geração materializada na competência.
              </p>
            </div>

            <button
              onClick={() => {
                setModalError(null);
                setRecStartCompetence(selectedMonth);
                setIsRecurrenceModalOpen(true);
              }}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-xs transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Novo Fixo / Recorrência
            </button>
          </div>

          {recurrenceRules.length === 0 ? (
            <div className="p-8 text-center bg-slate-800/90 rounded-2xl border border-slate-700/80 shadow-xs">
              <Repeat className="w-10 h-10 text-slate-500 mx-auto mb-2" />
              <div className="text-sm font-semibold text-slate-200">Nenhuma regra fixa ou recorrente cadastrada</div>
              <p className="text-xs text-slate-400 mt-1">
                Cadastre contas fixas (aluguel, salário, internet) ou assinaturas recorrentes (Netflix, academia).
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {recurrenceRules.map((rule) => {
                const cat = categories.find((c) => c.id === rule.categoryId);
                const acc = accounts.find((a) => a.id === rule.defaultAccountId);
                const isFixed = rule.nature === 'fixed';
                const isRuleIncome = rule.type === 'income';
                return (
                  <div
                    key={rule.id}
                    className="p-5 rounded-2xl border border-slate-700/80 bg-slate-800/90 shadow-xs space-y-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-1.5 flex-wrap mb-1">
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                              isFixed
                                ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30'
                                : 'bg-purple-500/15 text-purple-300 border-purple-500/30'
                            }`}
                          >
                            {isFixed ? 'Fixo Mensal' : 'Recorrente / Assinatura'}
                          </span>
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                              isRuleIncome
                                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                : 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                            }`}
                          >
                            {isRuleIncome ? 'Receita' : 'Despesa'}
                          </span>
                        </div>
                        <div className="text-sm font-bold text-white">{rule.title}</div>
                        {rule.description && (
                          <div className="text-xs text-slate-400 mt-0.5">{rule.description}</div>
                        )}
                      </div>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider shrink-0 ${
                          rule.status === 'active'
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                            : rule.status === 'paused'
                            ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                            : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                        }`}
                      >
                        {rule.status === 'active' ? 'Ativa' : rule.status === 'paused' ? 'Pausada' : 'Cancelada'}
                      </span>
                    </div>

                    <div className="text-xl font-black text-white font-mono">
                      {formatCentsToBRL(rule.amountCents)}
                      <span className="text-xs font-sans font-normal text-slate-400 ml-1">
                        / {rule.frequency === 'monthly' ? 'mês' : rule.frequency === 'weekly' ? 'semana' : 'ano'}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400 pt-2 border-t border-slate-700/70">
                      <div>
                        <span className="font-semibold text-slate-200">Vencimento:</span> Dia {rule.dueDay}
                      </div>
                      <div>
                        <span className="font-semibold text-slate-200">Início:</span> {rule.startCompetence}
                      </div>
                      {cat && (
                        <div className="col-span-2 flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: cat.color || '#2563EB' }} />
                          <span className="text-slate-300 font-medium">{cat.name}</span>
                        </div>
                      )}
                      {acc && (
                        <div className="col-span-2 text-slate-400">
                          <span className="font-semibold text-slate-200">Conta:</span> {acc.name}
                        </div>
                      )}
                    </div>

                    {rule.status !== 'cancelled' && (
                      <div className="pt-2 border-t border-slate-700/70 flex items-center justify-between gap-1">
                        <button
                          onClick={() => handleToggleRecurrenceStatus(rule.id, rule.status)}
                          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-200 hover:text-white bg-slate-900 hover:bg-slate-700 border border-slate-700 rounded-lg cursor-pointer"
                        >
                          {rule.status === 'active' ? (
                            <>
                              <Pause className="w-3 h-3 text-amber-400" /> Pausar
                            </>
                          ) : (
                            <>
                              <Play className="w-3 h-3 text-emerald-400" /> Reativar
                            </>
                          )}
                        </button>

                        {rule.status === 'active' && (
                          <button
                            onClick={() => handleGenerateRecurrenceInstance(rule.id)}
                            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-indigo-300 hover:text-white bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 rounded-lg cursor-pointer"
                            title={`Materializar lançamento em Receitas & Despesas para ${selectedMonth}`}
                          >
                            <CalendarClock className="w-3 h-3" /> Gerar ({selectedMonth})
                          </button>
                        )}

                        <button
                          onClick={() => handleCancelRecurrenceRule(rule.id)}
                          className="px-2 py-1 text-xs text-rose-400 hover:text-rose-200 hover:bg-rose-500/15 rounded-lg cursor-pointer"
                        >
                          Cancelar
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ABA 8: PARCELAMENTOS */}
      {activeTab === 'installments' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-white">
                Contratos de Parcelamento
              </h2>
              <p className="text-xs text-slate-400">
                Financiamentos e compras parceladas (novas ou em andamento) com conservação contábil de centavos e integração a faturas de cartão.
              </p>
            </div>

            <button
              onClick={() => {
                setModalError(null);
                setInstStartMonth(selectedMonth);
                setIsInstallmentModalOpen(true);
              }}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-xs transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Novo Parcelamento
            </button>
          </div>

          {installmentContracts.length === 0 ? (
            <div className="p-8 text-center bg-slate-800/90 rounded-2xl border border-slate-700/80 shadow-xs">
              <Layers className="w-10 h-10 text-slate-500 mx-auto mb-2" />
              <div className="text-sm font-semibold text-slate-200">Nenhum contrato de parcelamento ativo</div>
              <p className="text-xs text-slate-400 mt-1">
                Registre compras parceladas no cartão de crédito, empréstimos ou parcelamentos já em andamento.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {installmentContracts.map((contract) => {
                const isExpanded = expandedContractId === contract.id;
                const occs = contractOccurrences[contract.id] || [];
                const isLoadingOccs = loadingOccurrences[contract.id];
                const card = accounts.find((a) => a.id === contract.sourceCardAccountId);
                const startIdx = contract.initialInstallmentNumber || 1;
                const projectedInstallments = Math.max(1, contract.totalInstallmentsCount - startIdx + 1);
                const activeAllocationCents = contract.remainingAmountCents ?? contract.totalContractAmountCents;

                return (
                  <div
                    key={contract.id}
                    className="p-5 rounded-2xl border border-slate-700/80 bg-slate-800/90 shadow-xs space-y-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-bold text-white">{contract.title}</span>
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                              contract.status === 'active'
                                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                                : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                            }`}
                          >
                            {contract.status === 'active' ? 'Ativo' : 'Cancelado Antecipadamente'}
                          </span>
                          {startIdx > 1 && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                              Em andamento ({startIdx}/{contract.totalInstallmentsCount} → {contract.totalInstallmentsCount}/{contract.totalInstallmentsCount})
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5 flex flex-wrap items-center gap-2">
                          <span>
                            {contract.fundingSource === 'credit_card'
                              ? `Cartão de Crédito ${card ? `(${card.name})` : ''}`
                              : 'Empréstimo Pessoal'}
                          </span>
                          <span>•</span>
                          <span>Início projeção: {contract.startCompetenceMonth}</span>
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="text-lg font-black text-white font-mono">
                          {formatCentsToBRL(activeAllocationCents)}
                        </div>
                        <div className="text-xs text-slate-400">
                          {projectedInstallments} parcela(s) de ~{formatCentsToBRL(Math.round(activeAllocationCents / projectedInstallments))}
                        </div>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-slate-700/70 flex items-center justify-between">
                      <button
                        onClick={() => handleToggleContractOccurrences(contract.id)}
                        className="flex items-center gap-1 text-xs font-semibold text-indigo-400 hover:text-indigo-300 cursor-pointer"
                      >
                        {isExpanded ? (
                          <>
                            <ChevronUp className="w-4 h-4" /> Ocultar Parcelas
                          </>
                        ) : (
                          <>
                            <ChevronDown className="w-4 h-4" /> Ver Parcelas ({projectedInstallments})
                          </>
                        )}
                      </button>

                      {contract.status === 'active' && (
                        <button
                          onClick={() => {
                            setModalError(null);
                            setCancelContractModal(contract);
                            setCancelContractReason('');
                          }}
                          className="px-2.5 py-1 text-xs font-medium text-rose-400 hover:text-rose-200 hover:bg-rose-500/15 rounded-lg cursor-pointer"
                        >
                          Cancelar Antecipadamente
                        </button>
                      )}
                    </div>

                    {isExpanded && (
                      <div className="mt-3 pt-3 border-t border-slate-700/70 space-y-2">
                        {isLoadingOccs ? (
                          <div className="text-xs text-slate-400 py-2 text-center">Carregando parcelas...</div>
                        ) : occs.length === 0 ? (
                          <div className="text-xs text-slate-400 py-2 text-center">Nenhuma parcela encontrada.</div>
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                            {occs.map((occ) => (
                              <div
                                key={occ.id}
                                className={`p-2.5 rounded-xl border text-xs ${
                                  occ.status === 'cancelled'
                                    ? 'bg-slate-900/40 border-slate-700/60 opacity-60'
                                    : occ.status === 'paid'
                                    ? 'bg-emerald-500/10 border-emerald-500/30'
                                    : 'bg-slate-900/80 border-slate-700/80'
                                }`}
                              >
                                <div className="flex items-center justify-between font-semibold">
                                  <span className="text-slate-200">
                                    Parcela {occ.installmentNumber}/{contract.totalInstallmentsCount}
                                  </span>
                                  <span
                                    className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase ${
                                      occ.status === 'paid'
                                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                                        : occ.status === 'billed'
                                        ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                                        : occ.status === 'cancelled'
                                        ? 'bg-slate-800 text-slate-400 line-through'
                                        : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                                    }`}
                                  >
                                    {occ.status === 'paid'
                                      ? 'Paga'
                                      : occ.status === 'billed'
                                      ? 'Faturada'
                                      : occ.status === 'cancelled'
                                      ? 'Cancelada'
                                      : 'Agendada'}
                                  </span>
                                </div>
                                <div className="mt-1 font-bold text-white font-mono">
                                  {formatCentsToBRL(occ.totalInstallmentAmountCents)}
                                </div>
                                <div className="text-[10px] text-slate-400 mt-0.5">
                                  Mês: {occ.competenceMonth} • Venc: {occ.dueDate}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* MODAL: NOVA TRANSAÇÃO */}
      {isTxModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-white">
                {txType === 'income' ? 'Nova Receita' : 'Nova Despesa'}
              </h3>
              <button
                onClick={() => {
                  setModalError(null);
                  setIsTxModalOpen(false);
                }}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalError && (
              <div className="mt-3 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-200 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <form onSubmit={handleCreateTransaction} className="space-y-3.5 mt-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Descrição *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Salário, Aluguel, Supermercado..."
                  value={txDesc}
                  onChange={(e) => setTxDesc(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Valor (R$) *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="0,00"
                    value={txAmount}
                    onChange={(e) => setTxAmount(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Data *
                  </label>
                  <input
                    type="date"
                    required
                    value={txDate}
                    onChange={(e) => setTxDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Categoria *
                </label>
                <select
                  required
                  value={txCategory}
                  onChange={(e) => setTxCategory(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Selecione...</option>
                  {categories
                    .filter((c) => !c.isArchived && (c.type === txType || c.type === 'both'))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Status *
                </label>
                <select
                  value={txStatus}
                  onChange={(e) => setTxStatus(e.target.value as PersonalTransactionStatus)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="paid">{txType === 'income' ? 'Recebido (Crédito em Conta)' : 'Pago (Débito em Conta/Cartão)'}</option>
                  <option value="pending">Pendente (A pagar/receber)</option>
                  <option value="forecast">Previsto (Planejamento futuro)</option>
                </select>
              </div>

              {txStatus === 'paid' && (
                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Conta / Cartão *
                  </label>
                  <select
                    required
                    value={txAccount}
                    onChange={(e) => setTxAccount(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Selecione...</option>
                    {accounts
                      .filter((a) => !a.isArchived)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({a.type === 'credit' ? 'Cartão de Crédito' : 'Conta/Carteira'})
                        </option>
                      ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Observações (Opcional)
                </label>
                <input
                  type="text"
                  placeholder="Anotações internas..."
                  value={txNotes}
                  onChange={(e) => setTxNotes(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setIsTxModalOpen(false);
                  }}
                  className="px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={txSubmitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {txSubmitting ? 'Salvando...' : 'Gravar Lançamento'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: AMORTIZAÇÃO / PAGAMENTO PARCIAL */}
      {partialTx && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-indigo-800/60">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-white">
                Amortização Parcial
              </h3>
              <button
                onClick={() => {
                  setModalError(null);
                  setPartialTx(null);
                }}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalError && (
              <div className="mt-3 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-200 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <div className="my-3 p-3 bg-indigo-950/50 border border-indigo-800/50 rounded-xl text-xs space-y-1 text-indigo-200">
              <div>Lançamento: <strong className="text-white">{partialTx.description}</strong></div>
              <div>Valor Original: <strong className="text-white">{formatCentsToBRL(partialTx.amountCents)}</strong></div>
              <div>
                Saldo Devedor Restante:{' '}
                <strong className="text-rose-400">
                  {formatCentsToBRL(partialTx.remainingAmountCents ?? partialTx.amountCents)}
                </strong>
              </div>
            </div>

            <form onSubmit={handleExecutePartialPayment} className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Valor da Amortização (R$) *
                </label>
                <input
                  type="text"
                  required
                  placeholder="0,00"
                  value={partialAmount}
                  onChange={(e) => setPartialAmount(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Conta para Movimentação *
                </label>
                <select
                  required
                  value={partialAccount}
                  onChange={(e) => setPartialAccount(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Selecione...</option>
                  {accounts
                    .filter((a) => !a.isArchived)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.type})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Data Efetiva *
                </label>
                <input
                  type="date"
                  required
                  value={partialDate}
                  onChange={(e) => setPartialDate(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setPartialTx(null);
                  }}
                  className="px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={partialSubmitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {partialSubmitting ? 'Gravando...' : 'Confirmar Amortização'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: TRANSFERÊNCIA ENTRE CONTAS PRÓPRIAS */}
      {isTransferModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-white">
                Transferência entre Contas Próprias
              </h3>
              <button
                onClick={() => {
                  setModalError(null);
                  setIsTransferModalOpen(false);
                }}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalError && (
              <div className="mt-3 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-200 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <form onSubmit={handleExecuteTransfer} className="space-y-3.5 mt-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Conta de Origem (Saída) *
                </label>
                <select
                  required
                  value={xferSource}
                  onChange={(e) => setXferSource(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Selecione...</option>
                  {accounts
                    .filter((a) => !a.isArchived && a.type !== 'credit')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({formatCentsToBRL(a.projectedBalanceCents)})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Conta de Destino (Entrada) *
                </label>
                <select
                  required
                  value={xferDest}
                  onChange={(e) => setXferDest(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Selecione...</option>
                  {accounts
                    .filter((a) => !a.isArchived && a.type !== 'credit' && a.id !== xferSource)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({formatCentsToBRL(a.projectedBalanceCents)})
                      </option>
                    ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Valor (R$) *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="0,00"
                    value={xferAmount}
                    onChange={(e) => setXferAmount(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Data da Transferência *
                  </label>
                  <input
                    type="date"
                    required
                    value={xferDate}
                    onChange={(e) => setXferDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Descrição (Opcional)
                </label>
                <input
                  type="text"
                  placeholder="Ex: Saque para carteira, Reserva de emergência..."
                  value={xferDesc}
                  onChange={(e) => setXferDesc(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setIsTransferModalOpen(false);
                  }}
                  className="px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={xferSubmitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {xferSubmitting ? 'Transferindo...' : 'Executar Transferência'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: PAGAR FATURA DE CARTÃO */}
      {payInvoiceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-purple-800/60">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-white">
                Pagar Fatura {payInvoiceModal.invoiceMonth}
              </h3>
              <button
                onClick={() => {
                  setModalError(null);
                  setPayInvoiceModal(null);
                }}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalError && (
              <div className="mt-3 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-200 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <div className="my-3 p-3 bg-purple-950/40 border border-purple-800/50 rounded-xl text-xs space-y-1 text-purple-200">
              <div>Total Devido: <strong className="text-white">{formatCentsToBRL(payInvoiceModal.totalDueAmountCents)}</strong></div>
              <div>Já Pago: <strong className="text-white">{formatCentsToBRL(payInvoiceModal.totalPaidAmountCents)}</strong></div>
              <div>
                Saldo Devedor Restante:{' '}
                <strong className="text-rose-400">
                  {formatCentsToBRL(payInvoiceModal.remainingBalanceCents)}
                </strong>
              </div>
            </div>

            <form onSubmit={handleExecutePayInvoice} className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Conta para Débito (Corrente / Carteira) *
                </label>
                <select
                  required
                  value={payInvSourceAcc}
                  onChange={(e) => setPayInvSourceAcc(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Selecione...</option>
                  {accounts
                    .filter((a) => !a.isArchived && a.type !== 'credit')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({formatCentsToBRL(a.projectedBalanceCents)})
                      </option>
                    ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Valor a Pagar (R$) *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="0,00"
                    value={payInvAmount}
                    onChange={(e) => setPayInvAmount(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Data do Pagamento *
                  </label>
                  <input
                    type="date"
                    required
                    value={payInvDate}
                    onChange={(e) => setPayInvDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setPayInvoiceModal(null);
                  }}
                  className="px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={payInvSubmitting}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {payInvSubmitting ? 'Processando...' : 'Confirmar Pagamento'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: NOVO ORÇAMENTO */}
      {isBudgetModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-white">
                Novo Orçamento Mensal ({selectedMonth})
              </h3>
              <button
                onClick={() => {
                  setModalError(null);
                  setIsBudgetModalOpen(false);
                }}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalError && (
              <div className="mt-3 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-200 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <form onSubmit={handleCreateBudget} className="space-y-3.5 mt-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Nome do Orçamento *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Limite Alimentação, Gastos com Lazer..."
                  value={budgetName}
                  onChange={(e) => setBudgetName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Valor Planejado (R$) *
                </label>
                <input
                  type="text"
                  required
                  placeholder="0,00"
                  value={budgetAmount}
                  onChange={(e) => setBudgetAmount(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Categorias Incluídas *
                </label>
                <div className="max-h-36 overflow-y-auto space-y-1.5 p-2 bg-slate-800 rounded-xl border border-slate-700">
                  {categories
                    .filter((c) => !c.isArchived && (c.type === 'expense' || c.type === 'both'))
                    .map((c) => {
                      const isChecked = budgetCatIds.includes(c.id);
                      return (
                        <label
                          key={c.id}
                          className="flex items-center gap-2 text-xs text-slate-200 hover:text-white cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => {
                              if (e.target.checked) setBudgetCatIds([...budgetCatIds, c.id]);
                              else setBudgetCatIds(budgetCatIds.filter((id) => id !== c.id));
                            }}
                            className="rounded text-indigo-600 focus:ring-indigo-500"
                          />
                          <span>{c.name}</span>
                        </label>
                      );
                    })}
                </div>
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setIsBudgetModalOpen(false);
                  }}
                  className="px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={budgetSubmitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {budgetSubmitting ? 'Salvando...' : 'Salvar Orçamento'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: NOVO REEMBOLSO */}
      {isRefundModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-white">
                Novo Reembolso a Receber
              </h3>
              <button
                onClick={() => {
                  setModalError(null);
                  setIsRefundModalOpen(false);
                }}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalError && (
              <div className="mt-3 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-200 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <form onSubmit={handleCreateRefund} className="space-y-3 mt-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Despesa Original Vinculada *
                </label>
                <select
                  required
                  value={refTxId}
                  onChange={(e) => setRefTxId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Selecione a despesa...</option>
                  {transactions
                    .filter((t) => t.type === 'expense' && t.status !== 'cancelled')
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.description} ({formatCentsToBRL(t.amountCents)}) - {t.competenceDate}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Nome do Devedor / Amigo *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Carlos, Ana..."
                  value={refDebtor}
                  onChange={(e) => setRefDebtor(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Valor a Reembolsar (R$) *
                </label>
                <input
                  type="text"
                  required
                  placeholder="0,00"
                  value={refAmount}
                  onChange={(e) => setRefAmount(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Descrição (Opcional)
                </label>
                <input
                  type="text"
                  placeholder="Ex: Parte do almoço..."
                  value={refDesc}
                  onChange={(e) => setRefDesc(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setIsRefundModalOpen(false);
                  }}
                  className="px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={refSubmitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {refSubmitting ? 'Salvando...' : 'Salvar Reembolso'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: RECEBER REEMBOLSO */}
      {receiveRefundModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-emerald-800/60">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-white">
                Receber Reembolso ({receiveRefundModal.debtorName})
              </h3>
              <button
                onClick={() => {
                  setModalError(null);
                  setReceiveRefundModal(null);
                }}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalError && (
              <div className="mt-3 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-200 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <div className="my-3 p-3 bg-emerald-950/40 border border-emerald-800/50 rounded-xl text-xs space-y-1 text-emerald-200">
              <div>Total Devido: <strong className="text-white">{formatCentsToBRL(receiveRefundModal.amountDueCents)}</strong></div>
              <div>Já Recebido: <strong className="text-white">{formatCentsToBRL(receiveRefundModal.amountReceivedCents)}</strong></div>
              <div>Resta: <strong className="text-emerald-300">{formatCentsToBRL(receiveRefundModal.remainingAmountCents)}</strong></div>
            </div>

            <form onSubmit={handleExecuteReceiveRefund} className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Conta para Crédito (Entrada) *
                </label>
                <select
                  required
                  value={receiveAccount}
                  onChange={(e) => setReceiveAccount(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Selecione...</option>
                  {accounts
                    .filter((a) => !a.isArchived && a.type !== 'credit')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({formatCentsToBRL(a.projectedBalanceCents)})
                      </option>
                    ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Valor Recebido (R$) *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="0,00"
                    value={receiveAmount}
                    onChange={(e) => setReceiveAmount(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 font-bold"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Data do Recebimento *
                  </label>
                  <input
                    type="date"
                    required
                    value={receiveDate}
                    onChange={(e) => setReceiveDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setReceiveRefundModal(null);
                  }}
                  className="px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={receiveSubmitting}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {receiveSubmitting ? 'Gravando...' : 'Confirmar Recebimento'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: NOVA CATEGORIA */}
      {isCategoryModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-white">
                Nova Categoria Individual
              </h3>
              <button
                onClick={() => {
                  setModalError(null);
                  setIsCategoryModalOpen(false);
                }}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalError && (
              <div className="mt-3 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-200 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <form onSubmit={handleCreateCategory} className="space-y-3 mt-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Nome da Categoria *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Farmácia, Viagens, Freelance..."
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Tipo *
                </label>
                <select
                  value={newCatType}
                  onChange={(e) => setNewCatType(e.target.value as any)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="expense">Despesa</option>
                  <option value="income">Receita</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Cor
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={newCatColor}
                    onChange={(e) => setNewCatColor(e.target.value)}
                    className="w-9 h-9 rounded-xl cursor-pointer border border-slate-700 p-0.5 bg-slate-800"
                  />
                  <span className="text-xs font-mono text-slate-400">{newCatColor}</span>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setIsCategoryModalOpen(false);
                  }}
                  className="px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={newCatSubmitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {newCatSubmitting ? 'Salvando...' : 'Salvar Categoria'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: NOVA RECORRÊNCIA OU LANÇAMENTO FIXO */}
      {isRecurrenceModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-white">
                Novo Lançamento Fixo ou Recorrente
              </h3>
              <button
                onClick={() => {
                  setModalError(null);
                  setIsRecurrenceModalOpen(false);
                }}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalError && (
              <div className="mt-3 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-200 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <form onSubmit={handleCreateRecurrence} className="space-y-3 mt-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Natureza *
                  </label>
                  <select
                    value={recNature}
                    onChange={(e) => setRecNature(e.target.value as RecurrenceRuleNature)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="fixed">Fixo Mensal (Ex: Aluguel, Salário)</option>
                    <option value="recurring">Recorrente / Assinatura (Ex: Streaming)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Tipo *
                  </label>
                  <select
                    value={recType}
                    onChange={(e) => {
                      setRecType(e.target.value as PersonalTransactionType);
                      setRecCategory('');
                    }}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="expense">Despesa</option>
                    <option value="income">Receita</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Título *
                </label>
                <input
                  type="text"
                  required
                  placeholder={recType === 'income' ? 'Ex: Salário Mensal, Aluguel Recebido...' : 'Ex: Aluguel, Internet Fibra, Netflix...'}
                  value={recTitle}
                  onChange={(e) => setRecTitle(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Valor Previsto (R$) *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="0,00"
                    value={recAmount}
                    onChange={(e) => setRecAmount(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-bold"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Frequência *
                  </label>
                  <select
                    value={recFrequency}
                    onChange={(e) => setRecFrequency(e.target.value as any)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="monthly">Mensal</option>
                    <option value="weekly">Semanal</option>
                    <option value="yearly">Anual</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Dia de Vencimento (1 a 31) *
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="31"
                    required
                    value={recDueDay}
                    onChange={(e) => setRecDueDay(Number(e.target.value))}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Mês de Início (YYYY-MM) *
                  </label>
                  <input
                    type="text"
                    required
                    pattern="\d{4}-\d{2}"
                    placeholder="2026-11"
                    value={recStartCompetence}
                    onChange={(e) => setRecStartCompetence(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Categoria
                </label>
                <select
                  value={recCategory}
                  onChange={(e) => setRecCategory(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">Selecione...</option>
                  {categories
                    .filter((c) => !c.isArchived && (c.type === recType || c.type === 'both'))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Conta Padrão (Opcional)
                </label>
                <select
                  value={recAccount}
                  onChange={(e) => setRecAccount(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">Nenhuma / Definir no lançamento</option>
                  {accounts
                    .filter((a) => !a.isArchived)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.type === 'credit' ? 'Cartão' : 'Conta'})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Descrição Adicional
                </label>
                <input
                  type="text"
                  placeholder="Ex: Assinatura premium família..."
                  value={recDesc}
                  onChange={(e) => setRecDesc(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <label className="flex items-start gap-2.5 p-3 rounded-xl bg-slate-800/80 border border-slate-700/80 cursor-pointer text-xs text-slate-200">
                <input
                  type="checkbox"
                  checked={recGenerateInitial}
                  onChange={(e) => setRecGenerateInitial(e.target.checked)}
                  className="mt-0.5 rounded text-indigo-600 focus:ring-indigo-500"
                />
                <span>
                  Já gerar lançamento materializado para o mês inicial (<strong className="text-indigo-300 font-mono">{recStartCompetence}</strong>) em Receitas &amp; Despesas
                </span>
              </label>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setIsRecurrenceModalOpen(false);
                  }}
                  className="px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={recSubmitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {recSubmitting ? 'Salvando...' : 'Criar Regra'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: NOVO PARCELAMENTO (NOVO OU EM ANDAMENTO) */}
      {isInstallmentModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-white">
                Novo Contrato de Parcelamento
              </h3>
              <button
                onClick={() => {
                  setModalError(null);
                  setIsInstallmentModalOpen(false);
                }}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalError && (
              <div className="mt-3 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-200 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <form onSubmit={handleCreateInstallment} className="space-y-3 mt-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Título da Compra / Financiamento *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Smartphone Novo, IPVA 2026, Sofá da Sala..."
                  value={instTitle}
                  onChange={(e) => setInstTitle(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <label className="flex items-start gap-2.5 p-3 rounded-xl bg-slate-800/80 border border-slate-700/80 cursor-pointer text-xs text-slate-200">
                <input
                  type="checkbox"
                  checked={instOngoing}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setInstOngoing(checked);
                    if (checked && instCurrentNumber < 2) {
                      setInstCurrentNumber(2);
                    }
                  }}
                  className="mt-0.5 rounded text-indigo-600 focus:ring-indigo-500"
                />
                <span>
                  Parcelamento já está em andamento (parcela inicial &gt; 1 — ex: estou na 5/10)
                </span>
              </label>

              {instOngoing && (
                <div className="p-3 rounded-xl bg-indigo-950/40 border border-indigo-800/50 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-semibold text-indigo-200 uppercase mb-1">
                        Parcela Atual (k) *
                      </label>
                      <input
                        type="number"
                        min="2"
                        max={instCount}
                        required
                        value={instCurrentNumber}
                        onChange={(e) => setInstCurrentNumber(Number(e.target.value))}
                        className="w-full px-3 py-1.5 bg-slate-900 border border-indigo-700/60 rounded-xl text-xs text-white font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-indigo-200 uppercase mb-1">
                        Modo do Valor *
                      </label>
                      <select
                        value={instAmountMode}
                        onChange={(e) => setInstAmountMode(e.target.value as 'remaining' | 'total')}
                        className="w-full px-2.5 py-1.5 bg-slate-900 border border-indigo-700/60 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      >
                        <option value="remaining">Saldo restante (k..N)</option>
                        <option value="total">Valor total original (1..N)</option>
                      </select>
                    </div>
                  </div>
                  <div className="text-[11px] text-indigo-200 leading-relaxed">
                    Projetará <strong className="text-white">{Math.max(1, instCount - instCurrentNumber + 1)}</strong> parcela(s) restante(s):{' '}
                    <strong className="text-indigo-300 font-mono">
                      {instCurrentNumber}/{instCount} até {instCount}/{instCount}
                    </strong>{' '}
                    a partir de <strong className="font-mono">{instStartMonth}</strong>, sem fabricar cobranças passadas (1/{instCount}..{Math.max(1, instCurrentNumber - 1)}/{instCount}).
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    {instOngoing && instAmountMode === 'remaining'
                      ? 'Saldo Restante (R$) *'
                      : 'Valor Total (R$) *'}
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="0,00"
                    value={instAmount}
                    onChange={(e) => setInstAmount(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-bold"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Total de Parcelas (N) *
                  </label>
                  <input
                    type="number"
                    min="2"
                    max="48"
                    required
                    value={instCount}
                    onChange={(e) => setInstCount(Number(e.target.value))}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-bold"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Forma de Pagamento *
                </label>
                <select
                  value={instFundingSource}
                  onChange={(e) => setInstFundingSource(e.target.value as any)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="credit_card">Cartão de Crédito (Projeção em Faturas)</option>
                  <option value="personal_loan">Empréstimo Pessoal / Financiamento</option>
                </select>
              </div>

              {instFundingSource === 'credit_card' && (
                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Cartão de Crédito *
                  </label>
                  <select
                    required
                    value={instCardAccount}
                    onChange={(e) => setInstCardAccount(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">Selecione o cartão...</option>
                    {accounts
                      .filter((a) => !a.isArchived && a.type === 'credit')
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    {instOngoing ? `Mês da Parcela ${instCurrentNumber}/${instCount} *` : '1º Mês de Competência *'}
                  </label>
                  <input
                    type="text"
                    required
                    pattern="\d{4}-\d{2}"
                    placeholder="2026-11"
                    value={instStartMonth}
                    onChange={(e) => setInstStartMonth(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Dia de Vencimento *
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="31"
                    required
                    value={instDueDay}
                    onChange={(e) => setInstDueDay(Number(e.target.value))}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setIsInstallmentModalOpen(false);
                  }}
                  className="px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={instSubmitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {instSubmitting ? 'Gerando...' : 'Criar Parcelamento'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: CANCELAR PARCELAMENTO ANTECIPADAMENTE */}
      {cancelContractModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-rose-800/60">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-white">
                Cancelar Contrato de Parcelamento
              </h3>
              <button
                onClick={() => {
                  setModalError(null);
                  setCancelContractModal(null);
                }}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalError && (
              <div className="mt-3 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-200 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <div className="my-3 p-3 bg-rose-950/40 border border-rose-800/50 rounded-xl text-xs space-y-1 text-rose-200">
              <div>Contrato: <strong className="text-white">{cancelContractModal.title}</strong></div>
              <div>Total do Contrato: <strong className="text-white">{formatCentsToBRL(cancelContractModal.totalContractAmountCents)}</strong></div>
              <p className="text-[11px] text-rose-300 mt-2">
                O cancelamento antecipado cancelará todas as parcelas agendadas ainda não faturadas/pagas e liberará imediatamente o limite projetado nas faturas de cartão.
              </p>
            </div>

            <form onSubmit={handleCancelInstallmentContractSubmit} className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Motivo do Cancelamento (Opcional)
                </label>
                <input
                  type="text"
                  placeholder="Ex: Devolução da mercadoria, quitação antecipada..."
                  value={cancelContractReason}
                  onChange={(e) => setCancelContractReason(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setCancelContractModal(null);
                  }}
                  className="px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Voltar
                </button>
                <button
                  type="submit"
                  disabled={cancelContractSubmitting}
                  className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-xl shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {cancelContractSubmitting ? 'Cancelando...' : 'Confirmar Cancelamento'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
