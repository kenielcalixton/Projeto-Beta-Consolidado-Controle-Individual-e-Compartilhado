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
  Eye,
  Pencil,
  Undo2,
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
  PersonalTransactionPaymentView,
  PersonalTransactionStatus,
  RecurrenceRule,
  InstallmentContract,
  InstallmentOccurrence,
  SharedExpense,
  Space,
} from '../../types/financeV3';
import { Transaction, UniversalTransactionPreset } from '../../types/finance';
import { resolveAutomatedV3Status, getTodayDateString } from '../../utils/financeEngine';
import { getUserAccounts } from '../../services/accountService';
import {
  getUserCategories,
  createCategory,
  updateCategory,
  archiveCategory,
  ensureDefaultCategories,
} from '../../services/categoryService';
import {
  recordPartialPayment,
  cancelPersonalTransaction,
  updatePersonalTransaction,
  reversePersonalTransactionPayment,
  getPersonalTransactionPayments,
  getUserPersonalTransactions,
} from '../../services/personalTransactionService';
import {
  executeInternalTransfer,
  getUserTransfers,
} from '../../services/transferService';
import {
  getCardInvoices,
  payCardInvoice,
  carryOverInvoiceBalance,
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
} from '../../services/refundService';
import {
  getRecurrenceRules,
  updateRecurrenceRuleStatus,
  generateRecurrenceInstance,
  getInstallmentContracts,
  getInstallmentOccurrences,
  cancelInstallmentContract,
} from '../../services/recurrenceService';
import { getUserSpaces, getSpaceMembers } from '../../services/spaceService';
import { getSharedExpenses } from '../../services/sharedFinanceService';
import {
  formatCentsToBRL,
  parseBRLToCents,
  validatePositiveCents,
} from '../../utils/movementLedger';
import {
  IconGridPicker,
  ColorPalettePicker,
  resolveHexColor,
  resolvePhosphorCategoryIcon,
} from '../ui/VisualPickers';

interface PersonalFinanceViewV3Props {
  userId: string;
  isDemo?: boolean;
  selectedMonth?: CompetenceMonthString;
  onChangeMonth?: (month: CompetenceMonthString) => void;
  refreshTrigger?: number;
  onOpenNewTransaction?: (preset?: UniversalTransactionPreset) => void;
  adhocTransactions?: Transaction[];
  userEmail?: string;
}

interface SharedExtratoEntry {
  id: string;
  spaceId: string;
  spaceName: string;
  title: string;
  description?: string;
  categoryId: string;
  categoryName: string;
  amountCents: number;
  competenceDate: string;
  dueDate?: string;
  validationStatus: SharedExpense['validationStatus'];
  commitmentStatus: SharedExpense['commitmentStatus'];
  paymentExecutionStatus: SharedExpense['paymentExecutionStatus'];
  originType: SharedExpense['originType'];
  createdByName: string;
  payerName: string;
  createdAt: string;
}

interface UnifiedExtratoEntry {
  key: string;
  id: string;
  scopeType: 'personal' | 'shared' | 'adhoc';
  spaceId?: string;
  scopeLabel: string;
  originLabel: string;
  authorLabel: string;
  accountLabel: string;
  description: string;
  categoryId: string;
  categoryName: string;
  type: 'income' | 'expense';
  amountCents: number;
  paidAmountCents?: number;
  remainingAmountCents?: number;
  competenceDate: string;
  dueDate?: string;
  paymentDate?: string;
  invoiceMonth?: string;
  notes?: string;
  statusKey: string;
  statusLabel: string;
  statusBadgeClass: string;
  createdAt: string;
  personalTx?: PersonalTransaction;
  sharedEntry?: SharedExtratoEntry;
  adhocTx?: Transaction;
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
  selectedMonth: propSelectedMonth,
  onChangeMonth,
  refreshTrigger = 0,
  onOpenNewTransaction,
  adhocTransactions = [],
  userEmail = '',
}) => {
  const [activeTab, setActiveTab] = useState<MainTab>('transactions');
  const [internalMonth, setInternalMonth] = useState<CompetenceMonthString>(() => {
    const now = new Date();
    return `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;
  });
  const selectedMonth = propSelectedMonth ?? internalMonth;
  const handleMonthChange = (nextMonth: CompetenceMonthString) => {
    setInternalMonth(nextMonth);
    onChangeMonth?.(nextMonth);
  };

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  // Dados carregados
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<PersonalCategory[]>([]);
  const [transactions, setTransactions] = useState<PersonalTransaction[]>([]);
  const [authorizedSpaces, setAuthorizedSpaces] = useState<Space[]>([]);
  const [sharedExtratoItems, setSharedExtratoItems] = useState<SharedExtratoEntry[]>([]);
  const [invoices, setInvoices] = useState<CreditCardInvoice[]>([]);
  const [transfers, setTransfers] = useState<InternalAccountTransfer[]>([]);
  const [budgets, setBudgets] = useState<PersonalBudgetProgress[]>([]);
  const [refunds, setRefunds] = useState<PersonalRefund[]>([]);

  // Filtros de Transações (Extrato Unificado)
  const [filterScope, setFilterScope] = useState<'all' | 'personal' | 'adhoc' | string>('all');
  const [filterType, setFilterType] = useState<'all' | 'income' | 'expense'>('all');
  const [filterStatus, setFilterStatus] = useState<'all' | PersonalTransactionStatus>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');

  // Modal Detalhes do Lançamento
  const [detailsEntry, setDetailsEntry] = useState<UnifiedExtratoEntry | null>(null);
  const [detailsPayments, setDetailsPayments] = useState<PersonalTransactionPaymentView[]>([]);
  const [detailsPaymentsLoading, setDetailsPaymentsLoading] = useState(false);

  // Modal Editar Lançamento
  const [editTxModal, setEditTxModal] = useState<PersonalTransaction | null>(null);
  const [editTxDesc, setEditTxDesc] = useState('');
  const [editTxAmount, setEditTxAmount] = useState('');
  const [editTxCategoryId, setEditTxCategoryId] = useState('');
  const [editTxCompDate, setEditTxCompDate] = useState('');
  const [editTxDueDate, setEditTxDueDate] = useState('');
  const [editTxNotes, setEditTxNotes] = useState('');
  const [editTxSubmitting, setEditTxSubmitting] = useState(false);

  // Modal Estornar Pagamento
  const [reverseTxModal, setReverseTxModal] = useState<PersonalTransaction | null>(null);
  const [reverseTxReason, setReverseTxReason] = useState('');
  const [reverseTxSubmitting, setReverseTxSubmitting] = useState(false);

  // Modal Cancelar Lançamento
  const [cancelTxModal, setCancelTxModal] = useState<PersonalTransaction | null>(null);
  const [cancelTxReason, setCancelTxReason] = useState('');
  const [cancelTxSubmitting, setCancelTxSubmitting] = useState(false);

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

  // Modal Nova / Editar Categoria
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<PersonalCategory | null>(null);
  const [newCatName, setNewCatName] = useState('');
  const [newCatType, setNewCatType] = useState<'income' | 'expense'>('expense');
  const [newCatColor, setNewCatColor] = useState('#2563EB');
  const [newCatIcon, setNewCatIcon] = useState('ph-tag');
  const [newCatSubmitting, setNewCatSubmitting] = useState(false);

  // Recorrências e Parcelamentos (Fase 9)
  const [recurrenceRules, setRecurrenceRules] = useState<RecurrenceRule[]>([]);
  const [installmentContracts, setInstallmentContracts] = useState<InstallmentContract[]>([]);
  const [expandedContractId, setExpandedContractId] = useState<string | null>(null);
  const [contractOccurrences, setContractOccurrences] = useState<Record<string, InstallmentOccurrence[]>>({});
  const [loadingOccurrences, setLoadingOccurrences] = useState<Record<string, boolean>>({});

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

      // 3. Transações individuais do Mês (normalizadas e desduplicadas)
      const txList = await getUserPersonalTransactions(
        userId,
        { competenceMonth: selectedMonth },
        isDemo
      );
      setTransactions(txList);

      // 4. Espaços compartilhados autorizados e lançamentos do mês
      const spacesList = await getUserSpaces(userId, false, isDemo, 'active').catch(() => []);
      setAuthorizedSpaces(spacesList);

      const sharedMap = new Map<string, SharedExtratoEntry>();
      await Promise.all(
        spacesList.map(async (sp) => {
          const [exps, mems] = await Promise.all([
            getSharedExpenses(sp.id, userId, isDemo).catch(() => []),
            getSpaceMembers(sp.id, userId, isDemo).catch(() => []),
          ]);
          const memberNameByUid = new Map<string, string>();
          mems.forEach((m) => memberNameByUid.set(m.uid, m.displayName));

          for (const exp of exps) {
            const expMonth =
              exp.competenceMonth ||
              (exp.competenceDate ? exp.competenceDate.slice(0, 7) : '');
            if (expMonth !== selectedMonth) continue;
            const key = `${sp.id}_${exp.id}`;
            if (sharedMap.has(key)) continue;
            sharedMap.set(key, {
              id: exp.id,
              spaceId: sp.id,
              spaceName: sp.name,
              title: exp.title || 'Despesa compartilhada',
              description: exp.description,
              categoryId: exp.categoryId || 'cat_shared',
              categoryName: exp.categoryName || 'Compartilhado',
              amountCents: exp.totalOriginalAmountCents || 0,
              competenceDate: exp.competenceDate || exp.dueDate || `${selectedMonth}-01`,
              dueDate: exp.dueDate,
              validationStatus: exp.validationStatus,
              commitmentStatus: exp.commitmentStatus,
              paymentExecutionStatus: exp.paymentExecutionStatus,
              originType: exp.originType,
              createdByName: memberNameByUid.get(exp.createdByUid) || 'Membro',
              payerName:
                (exp.payerUid ? memberNameByUid.get(exp.payerUid) : undefined) ||
                memberNameByUid.get(exp.createdByUid) ||
                'Membro',
              createdAt: exp.createdAt || '',
            });
          }
        })
      );
      setSharedExtratoItems(Array.from(sharedMap.values()));

      // 5. Faturas de Cartão
      const cardAccounts = accList.filter((a) => a.type === 'credit');
      const allInvoices: CreditCardInvoice[] = [];
      for (const card of cardAccounts) {
        const invs = await getCardInvoices(card.id, userId, isDemo);
        allInvoices.push(...invs);
      }
      setInvoices(allInvoices);

      // 6. Transferências
      const xferList = await getUserTransfers(userId, isDemo);
      setTransfers(xferList);

      // 7. Orçamentos com Progresso
      const bgtList = await getUserBudgetsWithProgress(userId, selectedMonth, isDemo);
      setBudgets(bgtList);

      // 8. Reembolsos
      const refList = await getUserRefunds(userId, isDemo);
      setRefunds(refList);

      // 9. Recorrências e Parcelamentos (sempre passando `scope` explícito!)
      const isSpecificAuthorizedSpace =
        filterScope !== 'all' &&
        filterScope !== 'personal' &&
        spacesList.some((s) => s.id === filterScope);

      const [rulesList, contractsList] = await Promise.all([
        getRecurrenceRules(
          isSpecificAuthorizedSpace
            ? { scope: 'shared', spaceId: filterScope }
            : { userId, scope: 'personal' },
          isDemo
        ),
        getInstallmentContracts(
          isSpecificAuthorizedSpace
            ? { scope: 'shared', spaceId: filterScope }
            : { userId, scope: 'personal' },
          isDemo
        ),
      ]);
      setRecurrenceRules(rulesList);
      setInstallmentContracts(contractsList);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao carregar dados financeiros';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [userId, selectedMonth, isDemo, filterScope]);

  useEffect(() => {
    loadAllData();
  }, [loadAllData, refreshTrigger]);

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
      .filter((t) => {
        if (t.type !== 'expense' || t.status === 'cancelled') return false;
        const autoKey = resolveAutomatedV3Status(t).key;
        return (
          autoKey === 'overdue' ||
          t.status === 'pending' ||
          t.status === 'forecast' ||
          t.status === 'partially_paid'
        );
      })
      .reduce((sum, t) => sum + (t.remainingAmountCents ?? t.amountCents), 0);
  }, [transactions]);

  const accountNameById = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.name));
    return map;
  }, [accounts]);

  // Extrato Unificado (Individual + Espaços autorizados, normalizado e desduplicado)
  const extratoEntries = useMemo<UnifiedExtratoEntry[]>(() => {
    const byKey = new Map<string, UnifiedExtratoEntry>();
    const today = getTodayDateString();

    for (const tx of transactions) {
      const key = `personal_${tx.id}`;
      if (byKey.has(key)) continue;
      const statusInfo = resolveAutomatedV3Status(tx);
      const originLabel =
        tx.originType === 'installment'
          ? 'Parcelamento'
          : tx.originType === 'recurrence'
          ? 'Recorrência / Fixo'
          : tx.originType === 'shopping_list'
          ? 'Aquisição / Lista'
          : 'Manual';
      const accName = tx.accountId
        ? accountNameById.get(tx.accountId) || 'Conta vinculada'
        : 'Sem conta vinculada';

      byKey.set(key, {
        key,
        id: tx.id,
        scopeType: 'personal',
        scopeLabel: 'Individual',
        originLabel,
        authorLabel: 'Individual (Você)',
        accountLabel: accName,
        description: tx.description,
        categoryId: tx.categoryId,
        categoryName: tx.categoryName,
        type: tx.type,
        amountCents: tx.amountCents,
        paidAmountCents: tx.paidAmountCents,
        remainingAmountCents: tx.remainingAmountCents,
        competenceDate: tx.competenceDate,
        dueDate: tx.dueDate,
        paymentDate: tx.paymentDate,
        invoiceMonth: tx.invoiceMonth,
        notes: tx.notes,
        statusKey: statusInfo.key,
        statusLabel: statusInfo.label,
        statusBadgeClass: statusInfo.badgeClass,
        createdAt: tx.createdAt,
        personalTx: tx,
      });
    }

    for (const sh of sharedExtratoItems) {
      const key = `shared_${sh.spaceId}_${sh.id}`;
      if (byKey.has(key)) continue;
      const isCancelled =
        sh.commitmentStatus === 'cancelled_pre_payment' ||
        sh.validationStatus === 'cancelled' ||
        sh.validationStatus === 'rejected';
      const isSettled =
        sh.paymentExecutionStatus === 'fully_paid' || sh.commitmentStatus === 'closed';
      const isPartial = sh.paymentExecutionStatus === 'partially_paid';
      const isOverdue = !isCancelled && !isSettled && Boolean(sh.dueDate && sh.dueDate < today);
      const sharedOriginLabel =
        sh.originType === 'shopping_list'
          ? 'Aquisição / Lista'
          : sh.originType === 'installment'
          ? 'Parcelamento'
          : sh.originType === 'recurrence'
          ? 'Recorrência / Fixo'
          : 'Espaço Compartilhado';

      const statusKey = isCancelled
        ? 'cancelled'
        : isSettled
        ? 'paid'
        : isPartial
        ? 'partially_paid'
        : isOverdue
        ? 'overdue'
        : 'pending';
      const statusLabel = isCancelled
        ? 'Cancelada'
        : isSettled
        ? 'Liquidada'
        : isPartial
        ? 'Parcialmente Liquidada'
        : isOverdue
        ? 'Vencida'
        : 'Em Aberto';
      const statusBadgeClass = isCancelled
        ? 'bg-slate-800 text-slate-400 border border-slate-700'
        : isSettled
        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
        : isPartial
        ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
        : isOverdue
        ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
        : 'bg-amber-500/15 text-amber-300 border border-amber-500/30';

      byKey.set(key, {
        key,
        id: sh.id,
        scopeType: 'shared',
        spaceId: sh.spaceId,
        scopeLabel: sh.spaceName,
        originLabel: sharedOriginLabel,
        authorLabel: `Criado por ${sh.createdByName} · Pagador: ${sh.payerName}`,
        accountLabel: `Espaço: ${sh.spaceName}`,
        description: sh.title,
        categoryId: sh.categoryId,
        categoryName: sh.categoryName,
        type: 'expense',
        amountCents: sh.amountCents,
        competenceDate: sh.competenceDate,
        dueDate: sh.dueDate,
        notes: sh.description,
        statusKey,
        statusLabel,
        statusBadgeClass,
        createdAt: sh.createdAt,
        sharedEntry: sh,
      });
    }

    for (const adhoc of adhocTransactions) {
      const adhocMonth = (adhoc.competenceDate || adhoc.dueDate || '').slice(0, 7);
      if (adhocMonth && adhocMonth !== selectedMonth) continue;
      const key = `adhoc_${adhoc.id}`;
      if (byKey.has(key)) continue;

      const myShare = adhoc.splits?.find(
        (s) => userEmail && s.email?.toLowerCase() === userEmail.toLowerCase()
      );
      const isCancelled = adhoc.status === 'rejected';
      const isPaid = adhoc.status === 'paid';
      const isValidating = adhoc.status === 'validating';
      const isOverdue = !isCancelled && !isPaid && Boolean(adhoc.dueDate && adhoc.dueDate < today);

      const statusKey = isCancelled
        ? 'cancelled'
        : isPaid
        ? 'paid'
        : isOverdue
        ? 'overdue'
        : 'pending';
      const statusLabel = isCancelled
        ? 'Recusada / Cancelada'
        : isPaid
        ? 'Liquidada'
        : isValidating
        ? 'Aguardando Aceite'
        : isOverdue
        ? 'Vencida'
        : myShare?.status === 'accepted'
        ? 'Cota Aceita (A Pagar)'
        : 'Pendente';
      const statusBadgeClass = isCancelled
        ? 'bg-slate-800 text-slate-400 border border-slate-700'
        : isPaid
        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
        : isValidating
        ? 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30'
        : isOverdue
        ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
        : 'bg-amber-500/15 text-amber-300 border border-amber-500/30';

      byKey.set(key, {
        key,
        id: adhoc.id,
        scopeType: 'adhoc',
        scopeLabel: 'Rateio Avulso',
        originLabel: 'Rateio Avulso',
        authorLabel: `Lançado por ${adhoc.ownerName || adhoc.ownerEmail}`,
        accountLabel: adhoc.accountName || 'Rateio Avulso',
        description: adhoc.description,
        categoryId: adhoc.categoryId || 'uncategorized',
        categoryName: adhoc.categoryName || 'Rateio Avulso',
        type: 'expense',
        amountCents: Math.round((adhoc.amount || 0) * 100),
        competenceDate: adhoc.competenceDate,
        dueDate: adhoc.dueDate,
        notes: adhoc.disputeReason || undefined,
        statusKey,
        statusLabel,
        statusBadgeClass,
        createdAt: typeof adhoc.createdAt === 'string' ? adhoc.createdAt : adhoc.competenceDate,
        adhocTx: adhoc,
      });
    }

    return Array.from(byKey.values()).sort((a, b) => {
      const cmp = (b.competenceDate || '').localeCompare(a.competenceDate || '');
      if (cmp !== 0) return cmp;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
  }, [transactions, sharedExtratoItems, adhocTransactions, selectedMonth, userEmail, accountNameById]);

  const filteredTransactions = useMemo(() => {
    return extratoEntries.filter((entry) => {
      if (filterScope === 'personal' && entry.scopeType !== 'personal') return false;
      if (filterScope === 'adhoc' && entry.scopeType !== 'adhoc') return false;
      if (
        filterScope !== 'all' &&
        filterScope !== 'personal' &&
        filterScope !== 'adhoc' &&
        entry.spaceId !== filterScope
      ) {
        return false;
      }
      if (filterType !== 'all' && entry.type !== filterType) return false;
      if (filterStatus !== 'all' && entry.statusKey !== filterStatus) return false;
      if (filterCategory !== 'all' && entry.categoryId !== filterCategory) return false;
      return true;
    });
  }, [extratoEntries, filterScope, filterType, filterStatus, filterCategory]);

  // 2. Detalhes, Edição, Estorno e Amortização / Pagamento Parcial
  const handleOpenDetails = async (entry: UnifiedExtratoEntry) => {
    setDetailsEntry(entry);
    setDetailsPayments([]);
    if (entry.personalTx) {
      setDetailsPaymentsLoading(true);
      try {
        const payList = await getPersonalTransactionPayments(entry.personalTx.id, userId, isDemo);
        setDetailsPayments(payList);
      } catch (err) {
        console.warn('Falha ao carregar histórico de pagamentos:', err);
      } finally {
        setDetailsPaymentsLoading(false);
      }
    }
  };

  const handleOpenEditTx = (tx: PersonalTransaction) => {
    setModalError(null);
    setEditTxModal(tx);
    setEditTxDesc(tx.description);
    setEditTxAmount((tx.amountCents / 100).toFixed(2).replace('.', ','));
    setEditTxCategoryId(tx.categoryId || '');
    setEditTxCompDate(tx.competenceDate || '');
    setEditTxDueDate(tx.dueDate || tx.competenceDate || '');
    setEditTxNotes(tx.notes || '');
  };

  const handleConfirmEditTx = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTxModal) return;

    const cleanDesc = editTxDesc.trim();
    if (!cleanDesc) {
      setModalError('A descrição do lançamento é obrigatória.');
      return;
    }

    const canEditAmount =
      (editTxModal.paidAmountCents || 0) === 0 &&
      editTxModal.status !== 'paid' &&
      editTxModal.status !== 'partially_paid';

    let nextAmountCents: number | undefined;
    if (canEditAmount) {
      try {
        const parsed = parseBRLToCents(editTxAmount);
        validatePositiveCents(parsed);
        if (parsed !== editTxModal.amountCents) {
          nextAmountCents = parsed;
        }
      } catch (err: unknown) {
        setModalError(err instanceof Error ? err.message : 'Valor inválido');
        return;
      }
    }

    const selectedCat = categories.find((c) => c.id === editTxCategoryId);
    setEditTxSubmitting(true);
    setModalError(null);
    try {
      await updatePersonalTransaction(
        userId,
        editTxModal.id,
        {
          description: cleanDesc,
          categoryId: editTxCategoryId || editTxModal.categoryId,
          categoryName: selectedCat ? selectedCat.name : editTxModal.categoryName,
          competenceDate: editTxCompDate || editTxModal.competenceDate,
          dueDate: editTxDueDate || editTxModal.dueDate,
          notes: editTxNotes.trim(),
          ...(nextAmountCents !== undefined ? { amountCents: nextAmountCents } : {}),
        },
        isDemo
      );
      showToast('Lançamento atualizado com sucesso!');
      setEditTxModal(null);
      await loadAllData();
    } catch (err: unknown) {
      setModalError(err instanceof Error ? err.message : 'Falha ao atualizar lançamento');
    } finally {
      setEditTxSubmitting(false);
    }
  };

  const handleConfirmReverseTx = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reverseTxModal) return;
    if (!reverseTxReason.trim()) {
      setModalError('Informe a justificativa obrigatória para o estorno.');
      return;
    }

    setReverseTxSubmitting(true);
    setModalError(null);
    try {
      await reversePersonalTransactionPayment(
        reverseTxModal.id,
        userId,
        { reason: reverseTxReason.trim() },
        isDemo
      );
      showToast('Pagamento estornado compensatoriamente e saldo restaurado!');
      setReverseTxModal(null);
      setReverseTxReason('');
      await loadAllData();
    } catch (err: unknown) {
      setModalError(err instanceof Error ? err.message : 'Falha ao estornar pagamento');
    } finally {
      setReverseTxSubmitting(false);
    }
  };

  const handleConfirmCancelTx = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelTxModal) return;
    if (!cancelTxReason.trim()) {
      setModalError('Informe a justificativa obrigatória para o cancelamento.');
      return;
    }

    setCancelTxSubmitting(true);
    setModalError(null);
    try {
      await cancelPersonalTransaction(cancelTxModal.id, userId, cancelTxReason.trim(), isDemo);
      showToast('Lançamento cancelado com preservação contábil.');
      setCancelTxModal(null);
      setCancelTxReason('');
      await loadAllData();
    } catch (err: unknown) {
      setModalError(err instanceof Error ? err.message : 'Falha ao cancelar transação');
    } finally {
      setCancelTxSubmitting(false);
    }
  };

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

  // 9. Criar / Editar Categoria
  const handleOpenCategoryModal = (cat?: PersonalCategory) => {
    setModalError(null);
    if (cat) {
      setEditingCategory(cat);
      setNewCatName(cat.name);
      setNewCatType(cat.type === 'income' ? 'income' : 'expense');
      setNewCatColor(resolveHexColor(cat.color));
      setNewCatIcon(resolvePhosphorCategoryIcon(cat.icon));
    } else {
      setEditingCategory(null);
      setNewCatName('');
      setNewCatType('expense');
      setNewCatColor('#4F46E5');
      setNewCatIcon('ph-tag');
    }
    setIsCategoryModalOpen(true);
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatName.trim()) {
      setModalError('Nome da categoria é obrigatório.');
      return;
    }

    setNewCatSubmitting(true);
    setModalError(null);
    try {
      const normalizedColor = resolveHexColor(newCatColor);
      if (editingCategory) {
        await updateCategory(
          editingCategory.id,
          userId,
          {
            name: newCatName.trim(),
            type: newCatType,
            color: normalizedColor,
            icon: newCatIcon,
          },
          isDemo
        );
        showToast('Categoria atualizada com sucesso!');
      } else {
        await createCategory(
          userId,
          {
            name: newCatName.trim(),
            type: newCatType,
            color: normalizedColor,
            icon: newCatIcon,
          },
          isDemo
        );
        showToast('Categoria criada com sucesso!');
      }

      setIsCategoryModalOpen(false);
      setEditingCategory(null);
      setNewCatName('');
      await loadAllData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao salvar categoria';
      setModalError(msg);
    } finally {
      setNewCatSubmitting(false);
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
              onChange={(e) => handleMonthChange(e.target.value as CompetenceMonthString)}
              className="bg-transparent border-0 focus:outline-none cursor-pointer text-white font-bold"
            />
          </div>

          <button
            type="button"
            onClick={() => onOpenNewTransaction?.()}
            className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-xs transition-all cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Novo lançamento
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
            Receitas & Despesas ({extratoEntries.length})
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
                aria-label="Filtrar por escopo"
                value={filterScope}
                onChange={(e) => setFilterScope(e.target.value)}
                className="px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 text-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="all">Todos os Escopos</option>
                <option value="personal">Somente Individual</option>
                <option value="adhoc">Somente Rateio Avulso</option>
                {authorizedSpaces.map((sp) => (
                  <option key={sp.id} value={sp.id}>
                    Espaço: {sp.name}
                  </option>
                ))}
              </select>

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
                Utilize o botão "Novo lançamento" acima para registrar despesas ou receitas.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredTransactions.map((entry) => {
                const isIncome = entry.type === 'income';
                const isPaid = entry.statusKey === 'paid';
                const isPartiallyPaid = entry.statusKey === 'partially_paid';
                const isCancelled = entry.statusKey === 'cancelled';
                const tx = entry.personalTx;

                return (
                  <div
                    key={entry.key}
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
                            {entry.description}
                          </span>
                          <span
                            className={`px-2 py-0.5 text-[10px] font-bold rounded-md border ${
                              entry.scopeType === 'shared'
                                ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30'
                                : entry.scopeType === 'adhoc'
                                ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                                : 'bg-slate-800 text-slate-300 border-slate-700'
                            }`}
                          >
                            {entry.scopeLabel}
                          </span>
                          <span className="px-2 py-0.5 text-[10px] font-medium bg-slate-800/80 text-slate-400 border border-slate-700/80 rounded-md">
                            {entry.originLabel}
                          </span>
                          <span className="px-2 py-0.5 text-[10px] font-semibold bg-slate-800 text-slate-300 border border-slate-700 rounded-md">
                            {entry.categoryName}
                          </span>
                          <span
                            className={`px-2 py-0.5 text-[10px] font-bold rounded-md ${entry.statusBadgeClass}`}
                          >
                            {entry.statusLabel}
                          </span>
                          {entry.invoiceMonth && (
                            <span className="px-2 py-0.5 text-[10px] font-medium bg-purple-500/15 text-purple-300 border border-purple-500/30 rounded-md">
                              Fatura: {entry.invoiceMonth}
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400 mt-1">
                          <span>Data: {entry.competenceDate}</span>
                          {entry.dueDate && entry.dueDate !== entry.competenceDate && (
                            <span>• Vence: {entry.dueDate}</span>
                          )}
                          <span>• {entry.accountLabel}</span>
                          <span>• {entry.authorLabel}</span>
                          {isPartiallyPaid && (
                            <span className="text-amber-300 font-semibold">
                              • Amortizado: {formatCentsToBRL(entry.paidAmountCents || 0)} (Resta:{' '}
                              {formatCentsToBRL(entry.remainingAmountCents || 0)})
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between sm:justify-end gap-2 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-700/60">
                      <div className="text-right mr-1">
                        <span
                          className={`text-base font-black font-mono ${
                            isIncome ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {isIncome ? '+ ' : '- '}
                          {formatCentsToBRL(entry.amountCents)}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleOpenDetails(entry)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700 rounded-lg transition-all cursor-pointer"
                          title="Ver detalhes e histórico contábil"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Detalhes
                        </button>

                        {tx && !isCancelled && (
                          <button
                            type="button"
                            onClick={() => handleOpenEditTx(tx)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-slate-800 text-sky-300 border border-slate-700 hover:border-sky-500/40 hover:bg-sky-500/10 rounded-lg transition-all cursor-pointer"
                            title="Editar descrição, categoria ou datas"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                            Editar
                          </button>
                        )}

                        {tx && !isPaid && !isCancelled && (
                          <button
                            type="button"
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

                        {tx && !isCancelled && ((tx.paidAmountCents || 0) > 0 || isPaid || isPartiallyPaid) && (
                          <button
                            type="button"
                            onClick={() => {
                              setModalError(null);
                              setReverseTxModal(tx);
                              setReverseTxReason('');
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-amber-300 bg-amber-500/15 border border-amber-500/30 hover:bg-amber-500/25 rounded-lg transition-all cursor-pointer"
                            title="Estornar pagamento compensatoriamente sem apagar histórico"
                          >
                            <Undo2 className="w-3.5 h-3.5" />
                            Estornar
                          </button>
                        )}

                        {tx && !isCancelled && (
                          <button
                            type="button"
                            onClick={() => {
                              setModalError(null);
                              setCancelTxModal(tx);
                              setCancelTxReason('');
                            }}
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
              type="button"
              onClick={() => handleOpenCategoryModal()}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-xs transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Nova Categoria
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {categories.map((cat) => {
              const catColor = resolveHexColor(cat.color);
              const catIcon = resolvePhosphorCategoryIcon(cat.icon);
              return (
                <div
                  key={cat.id}
                  className={`p-3.5 rounded-xl border bg-slate-800/90 border-slate-700/80 flex items-center justify-between gap-2 shadow-xs ${
                    cat.isArchived ? 'opacity-50 bg-slate-800' : 'border-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className="w-8 h-8 rounded-xl shrink-0 flex items-center justify-center border"
                      style={{
                        backgroundColor: `${catColor}22`,
                        borderColor: `${catColor}55`,
                        color: catColor,
                      }}
                    >
                      <i className={`ph-fill ${catIcon} text-base`} aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-white leading-tight truncate">
                        {cat.name}
                      </div>
                      <span className="text-[10px] text-slate-400 capitalize">
                        {cat.type === 'income' ? 'Receita' : 'Despesa'}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleOpenCategoryModal(cat)}
                      className="text-[11px] text-sky-300 hover:text-white px-2 py-1 rounded bg-slate-900 hover:bg-slate-700 border border-slate-700 cursor-pointer"
                      title="Editar categoria"
                    >
                      Editar
                    </button>
                    <button
                      type="button"
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
                </div>
              );
            })}
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
              onClick={() =>
                onOpenNewTransaction?.({
                  presetRecurrenceType: 'fixed',
                  presetFixedNature: 'fixed',
                })
              }
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
              onClick={() =>
                onOpenNewTransaction?.({
                  presetRecurrenceType: 'installment',
                })
              }
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

      {/* MODAL: NOVA / EDITAR CATEGORIA */}
      {isCategoryModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-lg w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <div
                  className="w-8 h-8 rounded-xl flex items-center justify-center border"
                  style={{
                    backgroundColor: `${resolveHexColor(newCatColor)}22`,
                    borderColor: `${resolveHexColor(newCatColor)}55`,
                    color: resolveHexColor(newCatColor),
                  }}
                >
                  <i className={`ph-fill ${resolvePhosphorCategoryIcon(newCatIcon)} text-base`} />
                </div>
                <h3 className="text-base font-bold text-white">
                  {editingCategory ? 'Editar Categoria' : 'Nova Categoria Individual'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  setModalError(null);
                  setEditingCategory(null);
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

            <form onSubmit={handleSaveCategory} className="space-y-4 mt-3">
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

              <IconGridPicker
                label="Ícone"
                value={newCatIcon}
                onChange={setNewCatIcon}
                compact
              />

              <ColorPalettePicker
                label="Cor"
                value={newCatColor}
                onChange={setNewCatColor}
                mode="hex"
              />

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setEditingCategory(null);
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
                  {newCatSubmitting ? 'Salvando...' : editingCategory ? 'Atualizar Categoria' : 'Salvar Categoria'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: DETALHES DO LANÇAMENTO (EXTRATO) */}
      {detailsEntry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-lg w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-slate-700 space-y-4">
            <div className="flex items-start justify-between pb-3 border-b border-slate-800 gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="px-2 py-0.5 text-[10px] font-bold rounded-md bg-slate-800 border border-slate-700 text-slate-200">
                    {detailsEntry.scopeLabel}
                  </span>
                  <span className={`px-2 py-0.5 text-[10px] font-bold rounded-md ${detailsEntry.statusBadgeClass}`}>
                    {detailsEntry.statusLabel}
                  </span>
                </div>
                <h3 className="text-base font-bold text-white">{detailsEntry.description}</h3>
              </div>
              <button
                type="button"
                onClick={() => setDetailsEntry(null)}
                className="p-1 text-slate-400 hover:text-slate-200 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 p-3.5 rounded-xl bg-slate-800/80 border border-slate-700/80 text-xs">
              <div>
                <span className="text-slate-400 block text-[10px] uppercase">Valor Total</span>
                <strong className={`text-base font-mono ${detailsEntry.type === 'income' ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {detailsEntry.type === 'income' ? '+ ' : '- '}
                  {formatCentsToBRL(detailsEntry.amountCents)}
                </strong>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px] uppercase">Categoria</span>
                <strong className="text-white">{detailsEntry.categoryName}</strong>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px] uppercase">Competência</span>
                <strong className="text-white">{detailsEntry.competenceDate}</strong>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px] uppercase">Vencimento</span>
                <strong className="text-white">{detailsEntry.dueDate || detailsEntry.competenceDate}</strong>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px] uppercase">Conta / Vínculo</span>
                <strong className="text-white">{detailsEntry.accountLabel}</strong>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px] uppercase">Origem / Autoria</span>
                <strong className="text-white">{detailsEntry.authorLabel}</strong>
              </div>
              {detailsEntry.invoiceMonth && (
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase">Fatura</span>
                  <strong className="text-purple-300">{detailsEntry.invoiceMonth}</strong>
                </div>
              )}
              {detailsEntry.paymentDate && (
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase">Data de Pagamento</span>
                  <strong className="text-emerald-300">{detailsEntry.paymentDate}</strong>
                </div>
              )}
            </div>

            {detailsEntry.notes && (
              <div className="p-3 rounded-xl bg-slate-800/60 border border-slate-700/70 text-xs text-slate-300">
                <span className="block text-[10px] font-semibold uppercase text-slate-400 mb-1">
                  Observações / Histórico
                </span>
                {detailsEntry.notes}
              </div>
            )}

            {detailsEntry.adhocTx && detailsEntry.adhocTx.splits?.length > 0 && (
              <div className="space-y-2">
                <span className="block text-[11px] font-semibold uppercase text-slate-300">
                  Participantes do Rateio Avulso
                </span>
                <div className="divide-y divide-slate-800 rounded-xl border border-slate-700/80 bg-slate-900/70">
                  {detailsEntry.adhocTx.splits.map((s, idx) => (
                    <div key={`${s.email}_${idx}`} className="p-2.5 flex items-center justify-between text-xs">
                      <div>
                        <div className="font-semibold text-white">{s.name || s.email}</div>
                        <div className="text-[11px] text-slate-400">{s.email}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono font-bold text-slate-200">
                          {formatCentsToBRL(Math.round((s.responsibility || 0) * 100))}
                        </div>
                        <span className="text-[10px] text-slate-400 uppercase">{s.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {detailsEntry.personalTx && (
              <div className="space-y-2">
                <span className="block text-[11px] font-semibold uppercase text-slate-300">
                  Histórico de Pagamentos & Estornos
                </span>
                {detailsPaymentsLoading ? (
                  <div className="text-xs text-slate-400 py-2">Carregando histórico contábil...</div>
                ) : detailsPayments.length === 0 ? (
                  <div className="text-xs text-slate-400 p-3 rounded-xl bg-slate-800/50 border border-slate-700/60">
                    Nenhum pagamento individual registrado até o momento.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {detailsPayments.map((pay) => (
                      <div
                        key={pay.id}
                        className={`p-3 rounded-xl border text-xs ${
                          pay.isReversed
                            ? 'bg-amber-950/30 border-amber-800/60 text-amber-200'
                            : 'bg-slate-800/70 border-slate-700 text-slate-200'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold font-mono">{formatCentsToBRL(pay.amountCents)}</span>
                          <span className="text-[11px] text-slate-400">{pay.paymentDate}</span>
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          Conta: {accountNameById.get(pay.accountId) || pay.accountId}
                        </div>
                        {pay.isReversed && (
                          <div className="mt-1 text-[11px] text-amber-300 font-semibold">
                            Estornado em {pay.reversalDate}: {pay.reversalReason}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="pt-3 border-t border-slate-800 flex flex-wrap items-center justify-end gap-2">
              {detailsEntry.personalTx && detailsEntry.statusKey !== 'cancelled' && (
                <button
                  type="button"
                  onClick={() => {
                    const target = detailsEntry.personalTx!;
                    setDetailsEntry(null);
                    handleOpenEditTx(target);
                  }}
                  className="px-3 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-sky-300 border border-slate-700 rounded-xl cursor-pointer"
                >
                  Editar Lançamento
                </button>
              )}
              <button
                type="button"
                onClick={() => setDetailsEntry(null)}
                className="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl cursor-pointer"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: EDITAR LANÇAMENTO */}
      {editTxModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-white">Editar Lançamento</h3>
              <button
                type="button"
                onClick={() => {
                  setModalError(null);
                  setEditTxModal(null);
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

            <form onSubmit={handleConfirmEditTx} className="space-y-3 mt-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Descrição *
                </label>
                <input
                  type="text"
                  required
                  value={editTxDesc}
                  onChange={(e) => setEditTxDesc(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Valor (R$) *
                </label>
                <input
                  type="text"
                  value={editTxAmount}
                  onChange={(e) => setEditTxAmount(e.target.value)}
                  disabled={
                    (editTxModal.paidAmountCents || 0) > 0 ||
                    editTxModal.status === 'paid' ||
                    editTxModal.status === 'partially_paid'
                  }
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white font-bold disabled:opacity-50"
                />
                {((editTxModal.paidAmountCents || 0) > 0 ||
                  editTxModal.status === 'paid' ||
                  editTxModal.status === 'partially_paid') && (
                  <p className="text-[11px] text-amber-300 mt-1">
                    Valor bloqueado porque já existem pagamentos registrados. Estorne o pagamento antes se precisar alterar o valor.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Categoria
                </label>
                <select
                  value={editTxCategoryId}
                  onChange={(e) => setEditTxCategoryId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {categories
                    .filter((c) => !c.isArchived || c.id === editTxCategoryId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Data Competência *
                  </label>
                  <input
                    type="date"
                    required
                    value={editTxCompDate}
                    onChange={(e) => setEditTxCompDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                    Data Vencimento *
                  </label>
                  <input
                    type="date"
                    required
                    value={editTxDueDate}
                    onChange={(e) => setEditTxDueDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Observações
                </label>
                <textarea
                  rows={2}
                  value={editTxNotes}
                  onChange={(e) => setEditTxNotes(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
                />
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setEditTxModal(null);
                  }}
                  className="px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Voltar
                </button>
                <button
                  type="submit"
                  disabled={editTxSubmitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl disabled:opacity-50 cursor-pointer"
                >
                  {editTxSubmitting ? 'Salvando...' : 'Salvar Alterações'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: ESTORNAR PAGAMENTO (COMPENSATÓRIO) */}
      {reverseTxModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-amber-700/60">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-white">Estornar Pagamento</h3>
              <button
                type="button"
                onClick={() => {
                  setModalError(null);
                  setReverseTxModal(null);
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

            <div className="my-3 p-3 bg-amber-950/40 border border-amber-800/50 rounded-xl text-xs space-y-1 text-amber-200">
              <div>
                Lançamento: <strong className="text-white">{reverseTxModal.description}</strong>
              </div>
              <div>
                Total Pago:{' '}
                <strong className="text-white">
                  {formatCentsToBRL(reverseTxModal.paidAmountCents || reverseTxModal.amountCents)}
                </strong>
              </div>
              <p className="text-[11px] text-amber-300 mt-1">
                O estorno cria um movimento compensatório no livro-razão e preserva integralmente o histórico original, reabrindo o saldo em aberto do lançamento.
              </p>
            </div>

            <form onSubmit={handleConfirmReverseTx} className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Justificativa Obrigatória *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Pagamento lançado na conta errada, estorno bancário..."
                  value={reverseTxReason}
                  onChange={(e) => setReverseTxReason(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500"
                />
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setReverseTxModal(null);
                  }}
                  className="px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Voltar
                </button>
                <button
                  type="submit"
                  disabled={reverseTxSubmitting}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold rounded-xl disabled:opacity-50 cursor-pointer"
                >
                  {reverseTxSubmitting ? 'Estornando...' : 'Confirmar Estorno'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: CANCELAR LANÇAMENTO */}
      {cancelTxModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-rose-800/60">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-white">Cancelar Lançamento</h3>
              <button
                type="button"
                onClick={() => {
                  setModalError(null);
                  setCancelTxModal(null);
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
              <div>
                Lançamento: <strong className="text-white">{cancelTxModal.description}</strong>
              </div>
              <div>
                Valor: <strong className="text-white">{formatCentsToBRL(cancelTxModal.amountCents)}</strong>
              </div>
              <p className="text-[11px] text-rose-300 mt-1">
                O cancelamento mantém o registro histórico auditável e gera estorno compensatório para qualquer movimentação já consolidada.
              </p>
            </div>

            <form onSubmit={handleConfirmCancelTx} className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-200 uppercase mb-1">
                  Motivo do Cancelamento *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Compra duplicada, serviço cancelado..."
                  value={cancelTxReason}
                  onChange={(e) => setCancelTxReason(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500"
                />
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalError(null);
                    setCancelTxModal(null);
                  }}
                  className="px-3 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Voltar
                </button>
                <button
                  type="submit"
                  disabled={cancelTxSubmitting}
                  className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-xl disabled:opacity-50 cursor-pointer"
                >
                  {cancelTxSubmitting ? 'Cancelando...' : 'Confirmar Cancelamento'}
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
