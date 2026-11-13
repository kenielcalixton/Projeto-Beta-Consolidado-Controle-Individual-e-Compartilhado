import React, { useEffect, useState } from 'react';
import {
  Account,
  CentsInteger,
  CustodyBalanceSummary,
  CustodyReturn,
  CustodyTransfer,
  ExpenseApprovalRevocation,
  ExpenseLiability,
  ExpenseLiabilitySplitMethod,
  ExpensePaymentApproval,
  ExpensePaymentDeclaration,
  ExpensePaymentRejection,
  ExpenseRestitutionObligation,
  ExpenseRestitutionReceipt,
  PaymentDeclarationMethod,
  SharedExpense,
  Space,
  SpaceMember,
  SupplierRefundEvent,
  SupplierRefundType,
} from '../../types/financeV3';
import {
  approveExpensePayment,
  confirmRestitutionReceipt,
  createSharedExpense,
  declareExpensePayment,
  getExpenseLiabilities,
  getExpensePaymentDeclarations,
  getExpensePaymentRejections,
  getRestitutionReceipts,
  getExpenseSupplierRefunds,
  getSharedExpenses,
  getSpaceApprovalRevocations,
  getSpaceFinancialSummary,
  getSpacePaymentApprovals,
  getSpacePendingDeclarations,
  getSpaceRestitutions,
  rejectExpensePayment,
  recordSupplierRefund,
  reverseRestitutionReceipt,
  revokeExpensePaymentApproval,
  SpaceFinancialSummary,
} from '../../services/sharedFinanceService';
import {
  confirmCustodyReceipt,
  confirmCustodyReturnReceipt,
  createCustodyTransfer,
  declareCustodyReturn,
  getCustodyReturns,
  getSpaceCustodyBalances,
  getSpaceCustodyTransfers,
} from '../../services/custodyService';
import { calculateExpenseSplit, SplitParticipant } from '../../utils/splitEngine';
import { formatCentsToBRL, parseBRLToCents } from '../../utils/movementLedger';
import { getUserAccounts } from '../../services/accountService';
import { getSpaceMembers } from '../../services/spaceService';

interface SharedFinanceSectionV3Props {
  space: Space;
  userId: string;
  userName: string;
  isDemo?: boolean;
  activeTab: 'expenses' | 'liabilities' | 'validations' | 'refunds' | 'custody';
  onTabChange: (tab: 'expenses' | 'liabilities' | 'validations' | 'refunds' | 'custody') => void;
  onFeedback: (type: 'success' | 'error', text: string) => void;
}

export const SharedFinanceSectionV3: React.FC<SharedFinanceSectionV3Props> = ({
  space,
  userId,
  userName,
  isDemo = false,
  activeTab,
  onTabChange,
  onFeedback,
}) => {
  const isArchived = space.spaceStatus === 'archived';
  const isHistoricalOnly =
    !space.memberUids.includes(userId) && (space.historicalMemberUids?.includes(userId) ?? false);

  // Estados de dados
  const [loading, setLoading] = useState(true);
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [expenses, setExpenses] = useState<SharedExpense[]>([]);
  const [liabilitiesMap, setLiabilitiesMap] = useState<Record<string, ExpenseLiability[]>>({});
  const [expandedExpenseId, setExpandedExpenseId] = useState<string | null>(null);
  const [pendingDeclarations, setPendingDeclarations] = useState<ExpensePaymentDeclaration[]>([]);
  const [allApprovals, setAllApprovals] = useState<ExpensePaymentApproval[]>([]);
  const [allRevocations, setAllRevocations] = useState<ExpenseApprovalRevocation[]>([]);
  const [allRejections, setAllRejections] = useState<ExpensePaymentRejection[]>([]);
  const [allRestitutions, setAllRestitutions] = useState<ExpenseRestitutionObligation[]>([]);
  const [refunds, setRefunds] = useState<SupplierRefundEvent[]>([]);
  const [summary, setSummary] = useState<SpaceFinancialSummary | null>(null);

  // Modais
  const [isCreateExpenseModalOpen, setIsCreateExpenseModalOpen] = useState(false);
  const [isDeclareModalOpen, setIsDeclareModalOpen] = useState(false);
  const [isApproveModalOpen, setIsApproveModalOpen] = useState(false);
  const [isRejectModalOpen, setIsRejectModalOpen] = useState(false);
  const [isRevokeModalOpen, setIsRevokeModalOpen] = useState(false);
  const [isRefundModalOpen, setIsRefundModalOpen] = useState(false);
  const [isConfirmRestitutionModalOpen, setIsConfirmRestitutionModalOpen] = useState(false);
  const [selectedRestitutionForConfirm, setSelectedRestitutionForConfirm] =
    useState<ExpenseRestitutionObligation | null>(null);
  const [restitutionConfirmAccountId, setRestitutionConfirmAccountId] = useState('');
  const [restitutionConfirmAmountInput, setRestitutionConfirmAmountInput] = useState('');

  // Formulário: Nova Despesa
  const [expTitle, setExpTitle] = useState('');
  const [expDesc, setExpDesc] = useState('');
  const [expAmountInput, setExpAmountInput] = useState('');
  const [expCompetenceMonth, setExpCompetenceMonth] = useState(() =>
    new Date().toISOString().slice(0, 7)
  );
  const [expCompetenceDate, setExpCompetenceDate] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [expDueDate, setExpDueDate] = useState('');
  const [expCategory, setExpCategory] = useState('Geral');
  const [expResponsibleUid, setExpResponsibleUid] = useState(userId);
  const [expPayerUid, setExpPayerUid] = useState(userId);
  const [expSplitMethod, setExpSplitMethod] = useState<ExpenseLiabilitySplitMethod>('equal');
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([]);
  const [customPercentages, setCustomPercentages] = useState<Record<string, number>>({});
  const [customValues, setCustomValues] = useState<Record<string, string>>({});

  // Formulário: Declarar Pagamento
  const [declExpense, setDeclExpense] = useState<SharedExpense | null>(null);
  const [declLiability, setDeclLiability] = useState<ExpenseLiability | null>(null);
  const [declAmountInput, setDeclAmountInput] = useState('');
  const [declDate, setDeclDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [declMethod, setDeclMethod] = useState<PaymentDeclarationMethod>('pix');
  const [declNotes, setDeclNotes] = useState('');
  const [declProofUrl, setDeclProofUrl] = useState('');

  // Formulário: Aprovação
  const [selectedDeclForApproval, setSelectedDeclForApproval] =
    useState<ExpensePaymentDeclaration | null>(null);
  const [selectedDestAccountId, setSelectedDestAccountId] = useState('');

  // Formulário: Rejeição
  const [selectedDeclForRejection, setSelectedDeclForRejection] =
    useState<ExpensePaymentDeclaration | null>(null);
  const [rejectionReasonInput, setRejectionReasonInput] = useState('');

  // Formulário: Revogação
  const [selectedApprovalForRevocation, setSelectedApprovalForRevocation] =
    useState<ExpensePaymentApproval | null>(null);
  const [revocationReasonInput, setRevocationReasonInput] = useState('');

  // Formulário: Reembolso de Fornecedor
  const [selectedExpForRefund, setSelectedExpForRefund] = useState<SharedExpense | null>(null);
  const [refundType, setRefundType] = useState<SupplierRefundType>('partial_refund');
  const [refundAmountInput, setRefundAmountInput] = useState('');
  const [refundJustification, setRefundJustification] = useState('');

  // Estados da Fase 7: Custódia & Adiantamentos
  const [allCustodyTransfers, setAllCustodyTransfers] = useState<CustodyTransfer[]>([]);
  const [allCustodyBalances, setAllCustodyBalances] = useState<CustodyBalanceSummary[]>([]);
  const [isCreateCustodyModalOpen, setIsCreateCustodyModalOpen] = useState(false);
  const [isConfirmCustodyModalOpen, setIsConfirmCustodyModalOpen] = useState(false);
  const [isReturnCustodyModalOpen, setIsReturnCustodyModalOpen] = useState(false);
  const [selectedCustodyTransfer, setSelectedCustodyTransfer] = useState<CustodyTransfer | null>(null);

  // Formulário: Criar Custódia
  const [custodyRecipientUid, setCustodyRecipientUid] = useState('');
  const [custodyAmountInput, setCustodyAmountInput] = useState('');
  const [custodySourceAccountId, setCustodySourceAccountId] = useState('');
  const [custodyDescription, setCustodyDescription] = useState('');
  const [custodyNotes, setCustodyNotes] = useState('');

  // Formulário: Confirmar Recebimento de Custódia
  const [custodyDestAccountId, setCustodyDestAccountId] = useState('');
  const [custodyConfirmAmountInput, setCustodyConfirmAmountInput] = useState('');
  const [custodyConfirmNotes, setCustodyConfirmNotes] = useState('');

  // Formulário: Declarar Devolução de Custódia (Etapa 1: Custodiante)
  const [custodyReturnSourceAccountId, setCustodyReturnSourceAccountId] = useState('');
  const [custodyReturnAmountInput, setCustodyReturnAmountInput] = useState('');
  const [custodyReturnJustification, setCustodyReturnJustification] = useState('');

  // Formulário: Confirmar Recebimento de Devolução de Custódia (Etapa 2: Remetente)
  const [isConfirmCustodyReturnModalOpen, setIsConfirmCustodyReturnModalOpen] = useState(false);
  const [selectedCustodyReturnRecord, setSelectedCustodyReturnRecord] = useState<CustodyReturn | null>(null);
  const [custodyConfirmReturnDestAccountId, setCustodyConfirmReturnDestAccountId] = useState('');
  const [custodyConfirmReturnNotes, setCustodyConfirmReturnNotes] = useState('');

  // Formulário: Estorno de Recebimento de Restituição (Credor)
  const [isReverseRestitutionModalOpen, setIsReverseRestitutionModalOpen] = useState(false);
  const [selectedRestitutionForReverse, setSelectedRestitutionForReverse] = useState<ExpenseRestitutionObligation | null>(null);
  const [restitutionReceiptsList, setRestitutionReceiptsList] = useState<ExpenseRestitutionReceipt[]>([]);
  const [selectedRestitutionReceiptId, setSelectedRestitutionReceiptId] = useState('');
  const [restitutionReverseReason, setRestitutionReverseReason] = useState('');

  // Carrega todos os dados financeiros do espaço (Modo Real/Emulador e Modo Demo)
  const loadFinanceData = async () => {
    try {
      setLoading(true);
      const [mems, accs, exps, summ, pDecls, apps, revocs, restits, custTransfers, custBals] =
        await Promise.all([
          getSpaceMembers(space.id, userId, isDemo).catch(() => []),
          getUserAccounts(userId, false, isDemo).catch(() => []),
          getSharedExpenses(space.id, userId, isDemo).catch(() => []),
          getSpaceFinancialSummary(space.id, userId, isDemo).catch(() => null),
          getSpacePendingDeclarations(space.id, userId, isDemo).catch(() => []),
          getSpacePaymentApprovals(space.id, userId, isDemo).catch(() => []),
          getSpaceApprovalRevocations(space.id, userId, isDemo).catch(() => []),
          getSpaceRestitutions(space.id, isDemo).catch(() => []),
          getSpaceCustodyTransfers(space.id, isDemo).catch(() => []),
          getSpaceCustodyBalances(space.id, isDemo).catch(() => []),
        ]);

      setMembers(mems);
      setAccounts(accs);
      setExpenses(exps);
      setSummary(summ);
      setPendingDeclarations(pDecls);
      setAllApprovals(apps);
      setAllRevocations(revocs);
      setAllRestitutions(restits);
      setAllCustodyTransfers(custTransfers);
      setAllCustodyBalances(custBals);

      // Carrega obrigações e rejeições de cada despesa
      const liabs: Record<string, ExpenseLiability[]> = {};
      const rejs: ExpensePaymentRejection[] = [];
      for (const e of exps) {
        const [list, expRejs] = await Promise.all([
          getExpenseLiabilities(space.id, e.id, isDemo).catch(() => []),
          getExpensePaymentRejections(space.id, e.id, isDemo).catch(() => []),
        ]);
        liabs[e.id] = list;
        rejs.push(...expRejs);
      }
      setLiabilitiesMap(liabs);
      setAllRejections(rejs);
    } catch (err: any) {
      onFeedback('error', err.message || 'Erro ao carregar dados financeiros do espaço.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFinanceData();
  }, [space.id, userId]);

  // Inicializa participantes para nova despesa
  useEffect(() => {
    if (members.length > 0 && selectedParticipants.length === 0) {
      const activeUids = members
        .filter((m) => m.participationStatus === 'active')
        .map((m) => m.uid);
      setSelectedParticipants(activeUids);
    }
  }, [members]);

  // Cálculo ao vivo do rateio na criação
  let liveSplitPreview: ReturnType<typeof calculateExpenseSplit> = [];
  let liveSplitError: string | null = null;
  try {
    const totalCents = expAmountInput ? parseBRLToCents(expAmountInput) : 0;
    if (totalCents > 0 && selectedParticipants.length > 0) {
      const parts: SplitParticipant[] = selectedParticipants.map((uid) => {
        const m = members.find((mem) => mem.uid === uid);
        return { uid, name: m?.displayName || uid };
      });

      const parsedCustomVals: Record<string, CentsInteger> = {};
      for (const uid of selectedParticipants) {
        const raw = customValues[uid];
        parsedCustomVals[uid] = raw ? parseBRLToCents(raw) : 0;
      }

      liveSplitPreview = calculateExpenseSplit({
        totalAmountCents: totalCents,
        splitMethod: expSplitMethod,
        participants: parts,
        percentages: customPercentages,
        customValues: parsedCustomVals,
      });
    }
  } catch (err: any) {
    liveSplitError = err.message;
  }

  // Handler: Criar Despesa Compartilhada
  const handleCreateExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!expTitle.trim() || !expAmountInput) return;

    try {
      const totalAmountCents = parseBRLToCents(expAmountInput);
      const parts: SplitParticipant[] = selectedParticipants.map((uid) => {
        const m = members.find((mem) => mem.uid === uid);
        return { uid, name: m?.displayName || uid };
      });

      const parsedCustomVals: Record<string, CentsInteger> = {};
      for (const uid of selectedParticipants) {
        const raw = customValues[uid];
        parsedCustomVals[uid] = raw ? parseBRLToCents(raw) : 0;
      }

      await createSharedExpense(
        space.id,
        {
          spaceId: space.id,
          title: expTitle.trim(),
          description: expDesc.trim() || undefined,
          totalOriginalAmountCents: totalAmountCents,
          competenceMonth: expCompetenceMonth,
          competenceDate: expCompetenceDate,
          dueDate: expDueDate || undefined,
          categoryId: 'cat_shared',
          categoryName: expCategory,
          createdByUid: userId,
          responsibleUid: expResponsibleUid,
          payerUid: expPayerUid || expResponsibleUid,
          splitMethod: expSplitMethod,
          participants: parts,
          percentages: customPercentages,
          customValues: parsedCustomVals,
        },
        isDemo
      );

      onFeedback('success', `Despesa "${expTitle}" e rateio cadastrados com sucesso!`);
      setIsCreateExpenseModalOpen(false);
      setExpTitle('');
      setExpDesc('');
      setExpAmountInput('');
      await loadFinanceData();
    } catch (err: any) {
      onFeedback('error', err.message);
    }
  };

  // Handler: Abrir modal de declaração de pagamento
  const handleOpenDeclarePayment = (expense: SharedExpense, liability: ExpenseLiability) => {
    setDeclExpense(expense);
    setDeclLiability(liability);
    const rem = liability.remainingAmountCents ?? liability.adjustedShareAmountCents;
    setDeclAmountInput((rem / 100).toFixed(2).replace('.', ','));
    setIsDeclareModalOpen(true);
  };

  // Handler: Submeter declaração de pagamento
  const handleSubmitDeclaration = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!declExpense || !declLiability || !declAmountInput) return;

    try {
      const amountCents = parseBRLToCents(declAmountInput);
      await declareExpensePayment(
        {
          spaceId: space.id,
          expenseId: declExpense.id,
          memberUid: userId,
          memberName: userName,
          amountCents,
          paymentDate: declDate,
          paymentMethod: declMethod,
          notes: declNotes || undefined,
          proofUrl: declProofUrl || undefined,
        },
        isDemo
      );

      onFeedback(
        'success',
        'Pagamento informado com sucesso! Aguardando validação pelo responsável financeiro.'
      );
      setIsDeclareModalOpen(false);
      setDeclNotes('');
      setDeclProofUrl('');
      await loadFinanceData();
    } catch (err: any) {
      onFeedback('error', err.message);
    }
  };

  // Handler: Aprovar pagamento
  const handleConfirmApproval = async () => {
    if (!selectedDeclForApproval) return;
    try {
      await approveExpensePayment(
        {
          spaceId: space.id,
          expenseId: selectedDeclForApproval.expenseId,
          declarationId: selectedDeclForApproval.id,
          approverUid: userId,
          destinationAccountId: selectedDestAccountId || undefined,
        },
        isDemo
      );

      onFeedback('success', 'Pagamento aprovado com sucesso! Saldo e histórico atualizados.');
      setIsApproveModalOpen(false);
      setSelectedDeclForApproval(null);
      setSelectedDestAccountId('');
      await loadFinanceData();
    } catch (err: any) {
      onFeedback('error', err.message);
    }
  };

  // Handler: Rejeitar pagamento
  const handleConfirmRejection = async () => {
    if (!selectedDeclForRejection || !rejectionReasonInput.trim()) {
      onFeedback('error', 'A justificativa de rejeição é obrigatória.');
      return;
    }
    try {
      await rejectExpensePayment(
        {
          spaceId: space.id,
          expenseId: selectedDeclForRejection.expenseId,
          declarationId: selectedDeclForRejection.id,
          rejecterUid: userId,
          rejectionReason: rejectionReasonInput.trim(),
        },
        isDemo
      );

      onFeedback('success', 'Pagamento rejeitado e justificativa registrada.');
      setIsRejectModalOpen(false);
      setSelectedDeclForRejection(null);
      setRejectionReasonInput('');
      await loadFinanceData();
    } catch (err: any) {
      onFeedback('error', err.message);
    }
  };

  // Handler: Revogar aprovação
  const handleConfirmRevocation = async () => {
    if (!selectedApprovalForRevocation || !revocationReasonInput.trim()) {
      onFeedback('error', 'O motivo da revogação é obrigatório.');
      return;
    }
    try {
      await revokeExpensePaymentApproval(
        {
          spaceId: space.id,
          expenseId: selectedApprovalForRevocation.expenseId,
          approvalId: selectedApprovalForRevocation.id,
          revokerUid: userId,
          reason: revocationReasonInput.trim(),
        },
        isDemo
      );

      onFeedback(
        'success',
        'Aprovação revogada com sucesso! Evento compensatório registrado no histórico.'
      );
      setIsRevokeModalOpen(false);
      setSelectedApprovalForRevocation(null);
      setRevocationReasonInput('');
      await loadFinanceData();
    } catch (err: any) {
      onFeedback('error', err.message);
    }
  };

  // Handler: Confirmar recebimento real de restituição pelo credor legítimo
  const handleConfirmRestitution = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRestitutionForConfirm) return;
    if (!restitutionConfirmAccountId) {
      onFeedback('error', 'Selecione a conta bancária de destino.');
      return;
    }
    const cents = parseBRLToCents(restitutionConfirmAmountInput);
    if (!cents || cents <= 0) {
      onFeedback('error', 'Informe um valor válido em centavos.');
      return;
    }
    try {
      setLoading(true);
      await confirmRestitutionReceipt(
        {
          spaceId: space.id,
          expenseId: selectedRestitutionForConfirm.expenseId,
          restitutionId: selectedRestitutionForConfirm.id,
          creditorUid: userId,
          amountCents: cents,
          destinationAccountId: restitutionConfirmAccountId,
        },
        isDemo
      );
      onFeedback('success', 'Recebimento de restituição confirmado e creditado na sua conta com sucesso!');
      setIsConfirmRestitutionModalOpen(false);
      setSelectedRestitutionForConfirm(null);
      setRestitutionConfirmAccountId('');
      setRestitutionConfirmAmountInput('');
      await loadFinanceData();
    } catch (err: any) {
      onFeedback('error', err.message || 'Erro ao confirmar restituição.');
    } finally {
      setLoading(false);
    }
  };

  // Handler: Criar transferência de custódia
  const handleCreateCustody = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!custodyRecipientUid) {
      onFeedback('error', 'Selecione o participante custodiante.');
      return;
    }
    if (!custodySourceAccountId) {
      onFeedback('error', 'Selecione a conta bancária de origem.');
      return;
    }
    const cents = parseBRLToCents(custodyAmountInput);
    if (!cents || cents <= 0) {
      onFeedback('error', 'Informe um valor válido em centavos.');
      return;
    }
    try {
      setLoading(true);
      await createCustodyTransfer(
        userId,
        {
          spaceId: space.id,
          custodianUid: custodyRecipientUid,
          initialAmountCents: cents,
          sourceAccountId: custodySourceAccountId,
          description: custodyDescription.trim() || 'Transferência sob custódia',
          notes: custodyNotes.trim() || undefined,
        },
        isDemo
      );
      onFeedback('success', 'Transferência sob custódia declarada com sucesso!');
      setIsCreateCustodyModalOpen(false);
      setCustodyRecipientUid('');
      setCustodyAmountInput('');
      setCustodySourceAccountId('');
      setCustodyDescription('');
      setCustodyNotes('');
      await loadFinanceData();
    } catch (err: any) {
      onFeedback('error', err.message || 'Erro ao criar transferência sob custódia.');
    } finally {
      setLoading(false);
    }
  };

  // Handler: Confirmar recebimento de custódia pelo custodiante
  const handleConfirmCustody = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustodyTransfer) return;
    if (!custodyDestAccountId) {
      onFeedback('error', 'Selecione a conta bancária de destino.');
      return;
    }
    const cents = custodyConfirmAmountInput
      ? parseBRLToCents(custodyConfirmAmountInput)
      : selectedCustodyTransfer.initialAmountCents;
    if (!cents || cents <= 0) {
      onFeedback('error', 'Informe um valor válido em centavos.');
      return;
    }
    try {
      setLoading(true);
      await confirmCustodyReceipt(
        userId,
        {
          transferId: selectedCustodyTransfer.id,
          destinationAccountId: custodyDestAccountId,
          confirmedAmountCents: cents,
          notes: custodyConfirmNotes.trim() || undefined,
        },
        isDemo
      );
      onFeedback('success', 'Recebimento de custódia confirmado com sucesso!');
      setIsConfirmCustodyModalOpen(false);
      setSelectedCustodyTransfer(null);
      setCustodyDestAccountId('');
      setCustodyConfirmAmountInput('');
      setCustodyConfirmNotes('');
      await loadFinanceData();
    } catch (err: any) {
      onFeedback('error', err.message || 'Erro ao confirmar recebimento de custódia.');
    } finally {
      setLoading(false);
    }
  };

  // Handler: Declarar Devolução de Custódia (Etapa 1: Custodiante)
  const handleDeclareCustodyReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustodyTransfer) return;
    if (!custodyReturnSourceAccountId) {
      onFeedback('error', 'Selecione a sua conta de saída.');
      return;
    }
    const cents = parseBRLToCents(custodyReturnAmountInput);
    if (!cents || cents <= 0) {
      onFeedback('error', 'Informe um valor válido em centavos.');
      return;
    }
    try {
      setLoading(true);
      await declareCustodyReturn(
        userId,
        {
          transferId: selectedCustodyTransfer.id,
          sourceAccountId: custodyReturnSourceAccountId,
          amountCents: cents,
          justification: custodyReturnJustification.trim() || undefined,
        },
        isDemo
      );
      onFeedback('success', 'Devolução de custódia declarada com sucesso! Aguardando confirmação do remetente.');
      setIsReturnCustodyModalOpen(false);
      setSelectedCustodyTransfer(null);
      setCustodyReturnSourceAccountId('');
      setCustodyReturnAmountInput('');
      setCustodyReturnJustification('');
      await loadFinanceData();
    } catch (err: any) {
      onFeedback('error', err.message || 'Erro ao declarar devolução de custódia.');
    } finally {
      setLoading(false);
    }
  };

  // Handler: Abrir modal de confirmação de recebimento de devolução (Etapa 2: Remetente)
  const handleOpenConfirmCustodyReturnModal = async (t: CustodyTransfer) => {
    setSelectedCustodyTransfer(t);
    setCustodyConfirmReturnDestAccountId('');
    setCustodyConfirmReturnNotes('');
    try {
      setLoading(true);
      const returns = await getCustodyReturns(t.id, isDemo);
      const pending = returns.find((r) => r.status === 'pending_confirmation');
      if (!pending) {
        onFeedback('error', 'Nenhum registro de devolução pendente encontrado para esta transferência.');
        return;
      }
      setSelectedCustodyReturnRecord(pending);
      setIsConfirmCustodyReturnModalOpen(true);
    } catch (err: any) {
      onFeedback('error', err.message || 'Erro ao carregar devoluções pendentes.');
    } finally {
      setLoading(false);
    }
  };

  // Handler: Confirmar recebimento de devolução de custódia (Etapa 2: Remetente)
  const handleConfirmCustodyReturnReceipt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustodyTransfer || !selectedCustodyReturnRecord) return;
    if (!custodyConfirmReturnDestAccountId) {
      onFeedback('error', 'Selecione a sua conta bancária de destino.');
      return;
    }
    try {
      setLoading(true);
      await confirmCustodyReturnReceipt(
        userId,
        {
          transferId: selectedCustodyTransfer.id,
          returnId: selectedCustodyReturnRecord.id,
          destinationAccountId: custodyConfirmReturnDestAccountId,
          notes: custodyConfirmReturnNotes.trim() || undefined,
        },
        isDemo
      );
      onFeedback('success', 'Recebimento de devolução de custódia confirmado com sucesso!');
      setIsConfirmCustodyReturnModalOpen(false);
      setSelectedCustodyTransfer(null);
      setSelectedCustodyReturnRecord(null);
      setCustodyConfirmReturnDestAccountId('');
      setCustodyConfirmReturnNotes('');
      await loadFinanceData();
    } catch (err: any) {
      onFeedback('error', err.message || 'Erro ao confirmar recebimento de devolução.');
    } finally {
      setLoading(false);
    }
  };

  // Handler: Abrir modal de estorno de recebimento de restituição (Credor)
  const handleOpenReverseRestitutionModal = async (rest: ExpenseRestitutionObligation) => {
    setSelectedRestitutionForReverse(rest);
    setRestitutionReverseReason('');
    try {
      setLoading(true);
      const receipts = await getRestitutionReceipts(space.id, rest.expenseId, rest.id, isDemo);
      setRestitutionReceiptsList(receipts);
      if (receipts.length > 0) {
        setSelectedRestitutionReceiptId(receipts[receipts.length - 1].id);
      } else {
        setSelectedRestitutionReceiptId('');
      }
      setIsReverseRestitutionModalOpen(true);
    } catch (err: any) {
      onFeedback('error', err.message || 'Erro ao carregar recibos de restituição.');
    } finally {
      setLoading(false);
    }
  };

  // Handler: Confirmar estorno de recebimento de restituição (Credor)
  const handleReverseRestitution = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRestitutionForReverse) return;
    if (!selectedRestitutionReceiptId) {
      onFeedback('error', 'Nenhum recibo de restituição selecionado para estorno.');
      return;
    }
    if (!restitutionReverseReason.trim()) {
      onFeedback('error', 'Informe o motivo do estorno.');
      return;
    }
    try {
      setLoading(true);
      await reverseRestitutionReceipt(
        userId,
        {
          spaceId: space.id,
          expenseId: selectedRestitutionForReverse.expenseId,
          restitutionId: selectedRestitutionForReverse.id,
          receiptId: selectedRestitutionReceiptId,
          reversalReason: restitutionReverseReason.trim(),
        },
        isDemo
      );
      onFeedback('success', 'Recebimento de restituição estornado com sucesso!');
      setIsReverseRestitutionModalOpen(false);
      setSelectedRestitutionForReverse(null);
      setSelectedRestitutionReceiptId('');
      setRestitutionReverseReason('');
      await loadFinanceData();
    } catch (err: any) {
      onFeedback('error', err.message || 'Erro ao estornar recebimento de restituição.');
    } finally {
      setLoading(false);
    }
  };

  // Handler: Registrar Reembolso de Fornecedor
  const handleConfirmRefund = async () => {
    if (!selectedExpForRefund || !refundJustification.trim()) {
      onFeedback('error', 'A justificativa do reembolso é obrigatória.');
      return;
    }
    try {
      const amountRefundedCents = refundAmountInput ? parseBRLToCents(refundAmountInput) : 0;
      await recordSupplierRefund(
        {
          spaceId: space.id,
          expenseId: selectedExpForRefund.id,
          refundType,
          amountRefundedCents,
          recipientUid: userId,
          date: new Date().toISOString().slice(0, 10),
          justification: refundJustification.trim(),
        },
        isDemo
      );

      onFeedback('success', 'Reembolso do fornecedor registrado e cotas reajustadas!');
      setIsRefundModalOpen(false);
      setSelectedExpForRefund(null);
      setRefundAmountInput('');
      setRefundJustification('');
      await loadFinanceData();
    } catch (err: any) {
      onFeedback('error', err.message);
    }
  };

  // Minhas obrigações no espaço
  const myLiabilitiesList = Object.entries(liabilitiesMap).flatMap(([expId, liabs]) => {
    const exp = expenses.find((e) => e.id === expId);
    if (!exp) return [];
    return liabs
      .filter((l) => l.memberUid === userId)
      .map((l) => ({ liability: l, expense: exp }));
  });

  return (
    <div className="space-y-6">
      {/* 1. RESUMO FINANCEIRO DO ESPAÇO */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-3 shadow-xs">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">
              Despesas do Espaço
            </span>
            <span className="text-base font-extrabold text-white">
              {formatCentsToBRL(summary.totalExpensesCents)}
            </span>
          </div>
          <div className="bg-slate-800/90 border border-rose-900/60 rounded-xl p-3 shadow-xs bg-rose-950/20">
            <span className="text-[11px] font-semibold text-rose-600 uppercase tracking-wider block mb-1">
              Minhas Obrigações (A Pagar)
            </span>
            <span className="text-base font-extrabold text-rose-600">
              {formatCentsToBRL(summary.totalMyPendingToPayCents)}
            </span>
          </div>
          <div className="bg-slate-800/90 border border-emerald-900/60 rounded-xl p-3 shadow-xs bg-emerald-950/20">
            <span className="text-[11px] font-semibold text-emerald-600 uppercase tracking-wider block mb-1">
              Créditos a Receber
            </span>
            <span className="text-base font-extrabold text-emerald-600">
              {formatCentsToBRL(summary.totalMyPendingToReceiveCents)}
            </span>
          </div>
          <div className="bg-slate-800/90 border border-amber-900/60 rounded-xl p-3 shadow-xs bg-amber-950/20">
            <span className="text-[11px] font-semibold text-amber-700 uppercase tracking-wider block mb-1">
              Validações Pendentes
            </span>
            <span className="text-base font-extrabold text-amber-700">
              {summary.pendingValidationsCount}
            </span>
          </div>
        </div>
      )}

      {/* 2. CONTEÚDO DAS SUB-ABAS FINANCEIRAS */}

      {/* ABA: DESPESAS COMPARTILHADAS */}
      {activeTab === 'expenses' && (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-white">
                Despesas Compartilhadas e Rateios
              </h3>
              <p className="text-xs text-slate-400">
                Divisão exata de centavos entre participantes sem fundo coletivo ou caixa comum.
              </p>
            </div>
            {!isArchived && !isHistoricalOnly && (
              <button
                onClick={() => setIsCreateExpenseModalOpen(true)}
                className="px-3 py-1.5 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 flex items-center gap-1.5 shadow-sm"
              >
                <i className="ph ph-plus-circle text-sm" /> Nova Despesa
              </button>
            )}
          </div>

          {expenses.length === 0 ? (
            <div className="text-center py-8 border border-dashed border-slate-700/80 rounded-xl bg-slate-900/40">
              <i className="ph ph-receipt text-3xl text-gray-300 mb-2 block" />
              <p className="text-xs text-slate-400 font-medium">
                Nenhuma despesa compartilhada registrada neste espaço.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {expenses.map((exp) => {
                const liabs = liabilitiesMap[exp.id] || [];
                const isExpanded = expandedExpenseId === exp.id;
                const isResponsible = exp.responsibleUid === userId;
                const isCreator = exp.createdByUid === userId;

                return (
                  <div
                    key={exp.id}
                    className="border border-slate-700 rounded-xl p-4 hover:border-slate-600 transition-all bg-slate-900/70"
                  >
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-bold text-white">{exp.title}</h4>
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-blue-50 text-blue-700 border border-blue-100">
                            {exp.categoryName}
                          </span>
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-gray-100 text-slate-300">
                            Competência: {exp.competenceMonth}
                          </span>
                        </div>
                        {exp.description && (
                          <p className="text-xs text-slate-400">{exp.description}</p>
                        )}
                        <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-3 pt-1">
                          <span>
                            Validador:{' '}
                            <strong className="text-slate-200">
                              {members.find((m) => m.uid === exp.responsibleUid)?.displayName ||
                                exp.responsibleUid}
                            </strong>
                          </span>
                          <span>
                            Credor (Pagador):{' '}
                            <strong className="text-slate-200">
                              {members.find((m) => m.uid === (exp.payerUid || exp.responsibleUid))?.displayName ||
                                (exp.payerUid || exp.responsibleUid)}
                            </strong>
                          </span>
                          {exp.dueDate && <span>Vencimento: {exp.dueDate}</span>}
                        </div>
                      </div>

                      <div className="text-right space-y-2">
                        <div className="text-base font-extrabold text-white">
                          {formatCentsToBRL(exp.totalOriginalAmountCents)}
                        </div>
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() =>
                              setExpandedExpenseId(isExpanded ? null : exp.id)
                            }
                            className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold flex items-center gap-1"
                          >
                            {isExpanded ? 'Ocultar Rateio' : 'Ver Rateio'}
                            <i
                              className={`ph ph-caret-${isExpanded ? 'up' : 'down'}`}
                            />
                          </button>
                          {(isResponsible || isCreator) && !isArchived && (
                            <button
                              onClick={() => {
                                setSelectedExpForRefund(exp);
                                setIsRefundModalOpen(true);
                              }}
                              className="text-[11px] text-slate-400 hover:text-white font-medium px-2 py-0.5 border border-slate-700 rounded-md"
                            >
                              Reembolso
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Rateio expandido */}
                    {isExpanded && (
                      <div className="mt-4 pt-3 border-t border-slate-800">
                        <div className="text-[11px] font-bold text-slate-200 uppercase tracking-wider mb-2">
                          Cotas de Participação no Rateio:
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead className="bg-slate-900/80 text-slate-400 font-semibold uppercase text-[10px] border-b border-slate-700">
                              <tr>
                                <th className="py-1.5 px-2">Participante</th>
                                <th className="py-1.5 px-2">Método</th>
                                <th className="py-1.5 px-2">Cota Original</th>
                                <th className="py-1.5 px-2">Valor Pago</th>
                                <th className="py-1.5 px-2">Saldo Devedor</th>
                                <th className="py-1.5 px-2">Status</th>
                                <th className="py-1.5 px-2 text-right">Ação</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {liabs.map((l) => {
                                const isMe = l.memberUid === userId;
                                const remaining =
                                  l.remainingAmountCents ?? l.adjustedShareAmountCents;
                                const isPaid = (l.paidAmountCents || 0) >= l.adjustedShareAmountCents;

                                return (
                                  <tr key={l.id} className="hover:bg-slate-800/50">
                                    <td className="py-2 px-2 font-medium text-white">
                                      {l.memberName} {isMe && '(Você)'}
                                    </td>
                                    <td className="py-2 px-2 text-slate-400 capitalize">
                                      {l.splitMethod}
                                    </td>
                                    <td className="py-2 px-2 font-semibold text-slate-200">
                                      {formatCentsToBRL(l.adjustedShareAmountCents)}
                                    </td>
                                    <td className="py-2 px-2 text-emerald-600 font-semibold">
                                      {formatCentsToBRL(l.paidAmountCents || 0)}
                                    </td>
                                    <td className="py-2 px-2 text-rose-600 font-semibold">
                                      {formatCentsToBRL(remaining)}
                                    </td>
                                    <td className="py-2 px-2">
                                      <div className="flex flex-col gap-1 items-start">
                                        <span
                                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                            isPaid
                                              ? 'bg-emerald-50 text-emerald-700'
                                              : l.status === 'in_validation'
                                              ? 'bg-amber-50 text-amber-700'
                                              : 'bg-rose-50 text-rose-700'
                                          }`}
                                        >
                                          {isPaid
                                            ? 'Quitado'
                                            : l.status === 'in_validation'
                                            ? 'Em Validação'
                                            : 'Pendente'}
                                        </span>
                                        {Boolean(l.creditNoteCents && l.creditNoteCents > 0) && (
                                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200">
                                            Restituir: {formatCentsToBRL(l.creditNoteCents!)}
                                          </span>
                                        )}
                                      </div>
                                    </td>
                                    <td className="py-2 px-2 text-right">
                                      {isMe && !isPaid && !isArchived && (
                                        <button
                                          onClick={() =>
                                            handleOpenDeclarePayment(exp, l)
                                          }
                                          className="px-2 py-1 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-lg text-[10px] font-bold hover:bg-indigo-100"
                                        >
                                          Pagar
                                        </button>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ABA: MINHAS OBRIGAÇÕES */}
      {activeTab === 'liabilities' && (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-6 shadow-sm space-y-4">
          <div>
            <h3 className="text-sm font-bold text-white">
              Minhas Obrigações a Pagar
            </h3>
            <p className="text-xs text-slate-400">
              Cotas de despesas compartilhadas atribuídas a você neste espaço.
            </p>
          </div>

          {myLiabilitiesList.length === 0 ? (
            <div className="text-center py-8 border border-dashed border-slate-700/80 rounded-xl bg-slate-900/40">
              <i className="ph ph-check-circle text-3xl text-emerald-400 mb-2 block" />
              <p className="text-xs text-slate-400 font-medium">
                Você não possui cotas ou pendências financeiras neste espaço.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900/80 border-y border-slate-700 text-slate-400 font-semibold uppercase text-[10px]">
                  <tr>
                    <th className="py-2.5 px-3">Despesa</th>
                    <th className="py-2.5 px-3">Competência</th>
                    <th className="py-2.5 px-3">Credor (Responsável)</th>
                    <th className="py-2.5 px-3">Cota Total</th>
                    <th className="py-2.5 px-3">Valor Pago</th>
                    <th className="py-2.5 px-3">Saldo Restante</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3 text-right">Ação</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {myLiabilitiesList.map(({ liability, expense }) => {
                    const remaining =
                      liability.remainingAmountCents ?? liability.adjustedShareAmountCents;
                    const isPaid = (liability.paidAmountCents || 0) >= liability.adjustedShareAmountCents;
                    const creditorName =
                      members.find((m) => m.uid === (expense.payerUid || expense.responsibleUid))?.displayName ||
                      (expense.payerUid || expense.responsibleUid);

                    return (
                      <tr key={liability.id + expense.id} className="hover:bg-slate-800/50">
                        <td className="py-3 px-3">
                          <div className="font-bold text-white">{expense.title}</div>
                          <div className="text-[11px] text-slate-400">{expense.categoryName}</div>
                        </td>
                        <td className="py-3 px-3 text-slate-300 font-medium">
                          {expense.competenceMonth}
                        </td>
                        <td className="py-3 px-3 font-semibold text-slate-200">
                          {creditorName}
                        </td>
                        <td className="py-3 px-3 font-bold text-white">
                          {formatCentsToBRL(liability.adjustedShareAmountCents)}
                        </td>
                        <td className="py-3 px-3 text-emerald-600 font-semibold">
                          {formatCentsToBRL(liability.paidAmountCents || 0)}
                        </td>
                        <td className="py-3 px-3 text-rose-600 font-bold">
                          {formatCentsToBRL(remaining)}
                        </td>
                        <td className="py-3 px-3">
                          <div className="flex flex-col gap-1 items-start">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                isPaid
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : liability.status === 'in_validation'
                                  ? 'bg-amber-50 text-amber-700'
                                  : 'bg-rose-50 text-rose-700'
                              }`}
                            >
                              {isPaid
                                ? 'Quitado'
                                : liability.status === 'in_validation'
                                ? 'Em Validação'
                                : 'Pendente'}
                            </span>
                            {Boolean(liability.creditNoteCents && liability.creditNoteCents > 0) && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200">
                                Restituir: {formatCentsToBRL(liability.creditNoteCents!)}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right">
                          {!isPaid && !isArchived && (
                            <button
                              onClick={() => handleOpenDeclarePayment(expense, liability)}
                              className="px-3 py-1 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700"
                            >
                              Informar Pagamento
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ABA: VALIDAÇÕES DE PAGAMENTO */}
      {activeTab === 'validations' && (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-6 shadow-sm space-y-6">
          <div>
            <h3 className="text-sm font-bold text-white">
              Validações de Pagamentos Declarados
            </h3>
            <p className="text-xs text-slate-400">
              Autoridade exclusiva: Somente o responsável financeiro da despesa pode aprovar, rejeitar ou revogar.
            </p>
          </div>

          {/* Declarações Pendentes */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
              Aguardando Sua Validação ({pendingDeclarations.length})
            </h4>

            {pendingDeclarations.length === 0 ? (
              <p className="text-xs text-slate-400 italic">
                Nenhum pagamento pendente de aprovação sob sua responsabilidade.
              </p>
            ) : (
              <div className="space-y-2">
                {pendingDeclarations.map((decl) => {
                  const exp = expenses.find((e) => e.id === decl.expenseId);
                  return (
                    <div
                      key={decl.id}
                      className="border border-amber-200 bg-amber-50/20 rounded-xl p-4 flex items-center justify-between"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm text-white">
                            {decl.memberName}
                          </span>
                          <span className="text-[10px] bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-bold">
                            Declarou Pagamento
                          </span>
                        </div>
                        <div className="text-xs text-slate-300">
                          Despesa: <strong>{exp?.title || decl.expenseId}</strong> • Data:{' '}
                          {decl.paymentDate} • Método: {decl.paymentMethod.toUpperCase()}
                        </div>
                        {decl.notes && (
                          <div className="text-xs text-slate-400 italic">"{decl.notes}"</div>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        <div className="text-base font-extrabold text-white">
                          {formatCentsToBRL(decl.amountCents)}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => {
                              setSelectedDeclForApproval(decl);
                              setIsApproveModalOpen(true);
                            }}
                            className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-700"
                          >
                            Aprovar
                          </button>
                          <button
                            onClick={() => {
                              setSelectedDeclForRejection(decl);
                              setIsRejectModalOpen(true);
                            }}
                            className="px-3 py-1.5 bg-rose-50 text-rose-700 border border-rose-200 rounded-lg text-xs font-bold hover:bg-rose-100"
                          >
                            Rejeitar
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Histórico de Aprovações e Revogações (Imutável Append-Only) */}
          {allApprovals.length > 0 && (
            <div className="pt-4 border-t border-slate-800 space-y-3">
              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                Histórico de Aprovações e Revogações ({allApprovals.length})
              </h4>
              <div className="space-y-2.5">
                {allApprovals.map((appr) => {
                  const exp = expenses.find((e) => e.id === appr.expenseId);
                  const revoc = allRevocations.find((r) => r.approvalId === appr.id);
                  const isRevoked = Boolean(revoc) || Boolean(appr.isRevoked);
                  const isResponsible = appr.responsibleUid === userId;
                  const validatorName =
                    members.find((m) => m.uid === appr.responsibleUid)?.displayName ||
                    appr.responsibleUid;
                  const beneficiaryUid =
                    appr.beneficiaryUid || exp?.payerUid || appr.responsibleUid;
                  const beneficiaryName =
                    members.find((m) => m.uid === beneficiaryUid)?.displayName || beneficiaryUid;

                  return (
                    <div
                      key={appr.id}
                      className={`border rounded-xl p-3.5 flex items-start justify-between text-xs ${
                        isRevoked
                          ? 'border-slate-700 bg-slate-900/60'
                          : 'border-emerald-200 bg-emerald-50/10'
                      }`}
                    >
                      <div className="space-y-1.5">
                        <div className="font-bold text-white flex flex-wrap items-center gap-2">
                          <span>Aprovação #{appr.id.slice(0, 16)}...</span>
                          {isRevoked ? (
                            <span className="text-[10px] bg-rose-100 text-rose-800 px-2 py-0.5 rounded-full font-bold">
                              Revogada (Evento Compensatório)
                            </span>
                          ) : (
                            <span className="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-bold">
                              Ativa
                            </span>
                          )}
                        </div>
                        <div className="text-slate-300 text-[11px]">
                          Despesa: <strong>{exp?.title}</strong> • Valor:{' '}
                          <strong>{formatCentsToBRL(appr.amountCents)}</strong> • Declaração:{' '}
                          <span className="font-mono">{appr.declarationId.slice(0, 12)}...</span>
                        </div>
                        <div className="text-slate-400 text-[11px] flex flex-wrap gap-3">
                          <span>
                            Validador: <strong>{validatorName}</strong>
                          </span>
                          <span>
                            Beneficiário do Crédito: <strong>{beneficiaryName}</strong>
                          </span>
                          <span>Aprovado em: {appr.approvedAt.slice(0, 10)}</span>
                          {appr.financialMovementId && (
                            <span className="font-mono text-indigo-700">
                              Movimento Entrada: #{appr.financialMovementId.slice(0, 14)}...
                            </span>
                          )}
                        </div>

                        {revoc && (
                          <div className="mt-2 pt-2 border-t border-rose-200/60 bg-rose-50/50 rounded-lg p-2.5 space-y-1 text-[11px] text-rose-900">
                            <div className="font-bold flex items-center gap-1.5">
                              <i className="ph ph-arrow-counter-clockwise text-sm" />
                              <span>
                                Evento de Revogação #{revoc.id.slice(0, 14)}... ({revoc.revokedAt.slice(0, 10)})
                              </span>
                            </div>
                            <div>
                              Motivo da revogação: <strong>{revoc.reason}</strong>
                            </div>
                            {revoc.compensatoryMovementId && (
                              <div className="font-mono text-rose-700">
                                Movimento Compensatório (Outflow): #{revoc.compensatoryMovementId}
                              </div>
                            )}
                            <div className="text-[10px] text-slate-300 italic">
                              Nota contábil: Este estorno é exclusivamente um ajuste contábil de livro-razão e não executa transferência bancária automática.
                            </div>
                            {revoc.requiresRestitution && (
                              <div className="mt-1 px-2 py-1 bg-amber-100 border border-amber-300 text-amber-900 rounded-md font-bold text-[10px]">
                                ⚠ Restituição Financeira Pendente:{' '}
                                {formatCentsToBRL(revoc.restitutionPendingCents || revoc.revokedAmountCents)}{' '}
                                (crédito original já utilizado na conta de destino)
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      <div>
                        {!isRevoked && isResponsible && !isArchived && (
                          <button
                            onClick={() => {
                              setSelectedApprovalForRevocation(appr);
                              setIsRevokeModalOpen(true);
                            }}
                            className="px-2.5 py-1 text-rose-600 hover:text-rose-800 font-bold border border-rose-200 rounded-lg text-xs"
                          >
                            Revogar
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Histórico de Rejeições (Imutável Append-Only) */}
          {allRejections.length > 0 && (
            <div className="pt-4 border-t border-slate-800 space-y-3">
              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                Histórico de Rejeições ({allRejections.length})
              </h4>
              <div className="space-y-2">
                {allRejections.map((rej) => {
                  const exp = expenses.find((e) => e.id === rej.expenseId);
                  return (
                    <div
                      key={rej.id}
                      className="border border-rose-200 bg-rose-50/20 rounded-xl p-3 text-xs space-y-1"
                    >
                      <div className="font-bold text-white flex items-center gap-2">
                        <span>Rejeição #{rej.id.slice(0, 16)}...</span>
                        <span className="text-[10px] bg-rose-100 text-rose-800 px-2 py-0.5 rounded-full font-bold">
                          Recusado
                        </span>
                      </div>
                      <div className="text-slate-300 text-[11px]">
                        Despesa: <strong>{exp?.title}</strong> • Valor:{' '}
                        <strong>{formatCentsToBRL(rej.amountCents)}</strong> • Data:{' '}
                        {rej.rejectedAt.slice(0, 10)}
                      </div>
                      <div className="text-rose-700 text-[11px]">
                        Justificativa: <strong>{rej.reason}</strong>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Obrigações Formais de Restituição Financeira (Etapa 1) */}
          {allRestitutions.length > 0 && (
            <div className="pt-4 border-t border-slate-800 space-y-3">
              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                Obrigações de Restituição Financeira ({allRestitutions.length})
              </h4>
              <div className="space-y-2">
                {allRestitutions.map((rest) => {
                  const exp = expenses.find((e) => e.id === rest.expenseId);
                  const isCreditor = rest.creditorUid === userId;
                  const debtorMember = members.find((m) => m.uid === rest.debtorUid);
                  const creditorMember = members.find((m) => m.uid === rest.creditorUid);

                  return (
                    <div
                      key={rest.id}
                      className="border border-amber-200 bg-amber-50/20 rounded-xl p-3 text-xs space-y-1.5 flex flex-col md:flex-row md:items-center justify-between gap-3"
                    >
                      <div className="space-y-1">
                        <div className="font-bold text-white flex items-center gap-2">
                          <span>Restituição #{rest.id.slice(0, 16)}...</span>
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                              rest.status === 'settled'
                                ? 'bg-emerald-100 text-emerald-800'
                                : rest.status === 'partial'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-rose-100 text-rose-800'
                            }`}
                          >
                            {rest.status === 'settled'
                              ? 'Liquidada'
                              : rest.status === 'partial'
                              ? 'Parcialmente Paga'
                              : 'Pendente de Recomposição'}
                          </span>
                        </div>
                        <div className="text-slate-300 text-[11px]">
                          Despesa: <strong>{exp?.title || rest.expenseId}</strong> • Total a Recompor:{' '}
                          <strong>{formatCentsToBRL(rest.amountToRestoreCents)}</strong> • Já Restituído:{' '}
                          <strong className="text-emerald-700">{formatCentsToBRL(rest.restitutedAmountCents)}</strong> •
                          Saldo Restante:{' '}
                          <strong className="text-rose-700">{formatCentsToBRL(rest.remainingAmountCents)}</strong>
                        </div>
                        <div className="text-slate-400 text-[11px] flex flex-wrap gap-3">
                          <span>
                            Devedor da Restituição:{' '}
                            <strong>{debtorMember?.displayName || rest.debtorUid}</strong>
                          </span>
                          <span>
                            Credor do Ressarcimento:{' '}
                            <strong>{creditorMember?.displayName || rest.creditorUid}</strong>
                          </span>
                          <span>Motivo: {rest.reason}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {isCreditor && rest.status !== 'settled' && !isArchived && (
                          <button
                            onClick={() => {
                              setSelectedRestitutionForConfirm(rest);
                              setRestitutionConfirmAmountInput(
                                (rest.remainingAmountCents / 100).toFixed(2).replace('.', ',')
                              );
                              setIsConfirmRestitutionModalOpen(true);
                            }}
                            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold whitespace-nowrap shadow-xs"
                          >
                            Confirmar Recebimento
                          </button>
                        )}

                        {isCreditor && (rest.restitutedAmountCents || 0) > 0 && !isArchived && (
                          <button
                            onClick={() => handleOpenReverseRestitutionModal(rest)}
                            className="px-3 py-1.5 bg-rose-50 border border-rose-200 text-rose-700 hover:bg-rose-100 rounded-xl text-xs font-bold whitespace-nowrap shadow-xs"
                          >
                            Estornar Recebimento
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ABA: REEMBOLSOS DE FORNECEDORES */}
      {activeTab === 'refunds' && (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-6 shadow-sm space-y-4">
          <div>
            <h3 className="text-sm font-bold text-white">
              Reembolsos Comerciais de Fornecedores
            </h3>
            <p className="text-xs text-slate-400">
              Devoluções parciais, estornos de compras ou prejuízos irrecuperáveis com impacto nas cotas dos membros.
            </p>
          </div>

          {expenses.length === 0 ? (
            <p className="text-xs text-slate-400 italic">Nenhuma despesa para reembolso.</p>
          ) : (
            <div className="space-y-3">
              {expenses.map((exp) => (
                <div
                  key={exp.id}
                  className="border border-slate-700 rounded-xl p-4 flex items-center justify-between bg-slate-900/70"
                >
                  <div>
                    <h4 className="text-sm font-bold text-white">{exp.title}</h4>
                    <p className="text-xs text-slate-400">
                      Total: {formatCentsToBRL(exp.totalOriginalAmountCents)} • Competência:{' '}
                      {exp.competenceMonth}
                    </p>
                  </div>
                  {!isArchived && (exp.responsibleUid === userId || exp.createdByUid === userId) && (
                    <button
                      onClick={() => {
                        setSelectedExpForRefund(exp);
                        setIsRefundModalOpen(true);
                      }}
                      className="px-3 py-1.5 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-xl text-xs font-bold hover:bg-indigo-100"
                    >
                      Registrar Reembolso
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ABA: TRANSFERÊNCIAS SOB CUSTÓDIA E ADIANTAMENTOS (FASE 7) */}
      {activeTab === 'custody' && (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-6 shadow-sm space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-white">
                Transferências sob Custódia e Adiantamentos
              </h3>
              <p className="text-xs text-slate-400">
                Adiantamentos bilaterais entre participantes. Inexistência de caixa comum: cada centavo possui titularidade individual estrita.
              </p>
            </div>
            {!isArchived && !isHistoricalOnly && (
              <button
                onClick={() => setIsCreateCustodyModalOpen(true)}
                className="px-3 py-1.5 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 flex items-center gap-1.5 shadow-sm"
              >
                <i className="ph ph-plus-circle text-sm" /> Nova Transferência
              </button>
            )}
          </div>

          {/* Resumo consolidado de saldos de custódia */}
          {allCustodyBalances.length > 0 && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2">
              <span className="text-[11px] font-bold text-slate-200 uppercase tracking-wider block">
                Balanço Consolidado entre Participantes
              </span>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                {allCustodyBalances.map((b, idx) => {
                  const sName = members.find((m) => m.uid === b.senderUid)?.displayName || b.senderUid;
                  const cName = members.find((m) => m.uid === b.custodianUid)?.displayName || b.custodianUid;
                  return (
                    <div key={idx} className="bg-slate-900/80 p-3 rounded-lg border border-slate-700 space-y-1">
                      <div className="flex justify-between font-bold text-white">
                        <span>{sName} ➔ {cName}</span>
                        <span className="text-indigo-600">Disponível: {formatCentsToBRL(b.availableBalanceCents)}</span>
                      </div>
                      <div className="flex justify-between text-slate-400 text-[11px]">
                        <span>Total Confiado: {formatCentsToBRL(b.totalConfirmedCents || b.totalInitialCents)}</span>
                        <span>Usado: {formatCentsToBRL(b.totalUsedCents)} • Devolvido: {formatCentsToBRL(b.totalReturnedCents)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Lista de transferências sob custódia */}
          {allCustodyTransfers.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-xs italic">
              Nenhuma transferência sob custódia registrada no espaço.
            </div>
          ) : (
            <div className="space-y-3">
              {allCustodyTransfers.map((t) => {
                const sName = members.find((m) => m.uid === t.senderUid)?.displayName || t.senderUid;
                const cName = members.find((m) => m.uid === t.custodianUid)?.displayName || t.custodianUid;
                const isCustodian = t.custodianUid === userId;

                return (
                  <div
                    key={t.id}
                    className="border border-slate-700 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-slate-900/70"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white">
                          {t.description || 'Transferência sob custódia'}
                        </span>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            t.custodyStatus === 'pending_receipt'
                              ? 'bg-amber-100 text-amber-800'
                              : t.custodyStatus === 'return_pending_confirmation'
                              ? 'bg-amber-100 text-amber-800'
                              : t.custodyStatus === 'available'
                              ? 'bg-emerald-100 text-emerald-800'
                              : t.custodyStatus === 'partially_used'
                              ? 'bg-blue-100 text-blue-800'
                              : 'bg-gray-100 text-slate-200'
                          }`}
                        >
                          {t.custodyStatus === 'pending_receipt' && 'Aguardando Confirmação'}
                          {t.custodyStatus === 'return_pending_confirmation' && 'Devolução Aguardando Confirmação'}
                          {t.custodyStatus === 'available' && 'Disponível'}
                          {t.custodyStatus === 'partially_used' && 'Parcialmente Utilizado'}
                          {t.custodyStatus === 'fully_used' && 'Totalmente Utilizado'}
                          {t.custodyStatus === 'settled_by_usage' && 'Liquidado por Uso'}
                          {t.custodyStatus === 'settled_by_return' && 'Liquidado por Devolução'}
                          {t.custodyStatus === 'settled_by_mixed' && 'Liquidado Misto (Uso + Devolução)'}
                          {t.custodyStatus === 'partial_return_confirmed' && 'Devolução Parcial'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-300">
                        Remetente: <strong className="text-white">{sName}</strong> ➔ Custodiante:{' '}
                        <strong className="text-white">{cName}</strong>
                      </p>
                      <p className="text-xs text-slate-400">
                        Inicial: {formatCentsToBRL(t.initialAmountCents)} • Disponível:{' '}
                        <strong className="text-emerald-700">{formatCentsToBRL(t.availableBalanceCents)}</strong> • Utilizado:{' '}
                        {formatCentsToBRL(t.usedAmountCents)} • Devolvido:{' '}
                        {formatCentsToBRL(t.returnedAmountCents)}
                        {(t.reservedForReturnCents || 0) > 0 && (
                          <span className="text-amber-700 font-semibold"> • Em devolução: {formatCentsToBRL(t.reservedForReturnCents || 0)}</span>
                        )}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {/* Botão de confirmação inicial exclusivo para o custodiante */}
                      {isCustodian && t.custodyStatus === 'pending_receipt' && !isArchived && (
                        <button
                          onClick={() => {
                            setSelectedCustodyTransfer(t);
                            setCustodyConfirmAmountInput(
                              (t.initialAmountCents / 100).toFixed(2).replace('.', ',')
                            );
                            setIsConfirmCustodyModalOpen(true);
                          }}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold whitespace-nowrap shadow-xs"
                        >
                          Confirmar Recebimento
                        </button>
                      )}

                      {/* Botão de declaração de devolução exclusivo para o custodiante com saldo disponível */}
                      {isCustodian && t.availableBalanceCents > 0 && t.custodyStatus !== 'pending_receipt' && !isArchived && (
                        <button
                          onClick={() => {
                            setSelectedCustodyTransfer(t);
                            setCustodyReturnAmountInput(
                              (t.availableBalanceCents / 100).toFixed(2).replace('.', ',')
                            );
                            setIsReturnCustodyModalOpen(true);
                          }}
                          className="px-3 py-1.5 bg-indigo-50 border border-indigo-200 text-indigo-700 hover:bg-indigo-100 rounded-xl text-xs font-bold whitespace-nowrap shadow-xs"
                        >
                          Declarar Devolução
                        </button>
                      )}

                      {/* Botão de confirmação de recebimento da devolução exclusivo para o remetente original */}
                      {userId === t.senderUid && t.custodyStatus === 'return_pending_confirmation' && !isArchived && (
                        <button
                          onClick={() => handleOpenConfirmCustodyReturnModal(t)}
                          className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold whitespace-nowrap shadow-xs"
                        >
                          Confirmar Recebimento de Devolução
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

      {/* ======================================================================== */}
      {/* MODAL 1: NOVA DESPESA COMPARTILHADA                                       */}
      {/* ======================================================================== */}
      {isCreateExpenseModalOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-slate-900 rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-slate-700 space-y-4 my-8">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">Nova Despesa Compartilhada</h3>
              <button
                onClick={() => setIsCreateExpenseModalOpen(false)}
                className="text-slate-400 hover:text-slate-300"
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            <form onSubmit={handleCreateExpense} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="font-bold text-slate-200 block mb-1">Título da Despesa *</label>
                  <input
                    type="text"
                    required
                    value={expTitle}
                    onChange={(e) => setExpTitle(e.target.value)}
                    placeholder="Ex: Supermercado Mensal"
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                  />
                </div>

                <div>
                  <label className="font-bold text-slate-200 block mb-1">Valor Total (R$) *</label>
                  <input
                    type="text"
                    required
                    value={expAmountInput}
                    onChange={(e) => setExpAmountInput(e.target.value)}
                    placeholder="Ex: 300,00"
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-bold text-white"
                  />
                </div>

                <div>
                  <label className="font-bold text-slate-200 block mb-1">Categoria *</label>
                  <input
                    type="text"
                    required
                    value={expCategory}
                    onChange={(e) => setExpCategory(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                  />
                </div>

                <div>
                  <label className="font-bold text-slate-200 block mb-1">Competência (YYYY-MM) *</label>
                  <input
                    type="text"
                    required
                    value={expCompetenceMonth}
                    onChange={(e) => setExpCompetenceMonth(e.target.value)}
                    placeholder="2026-11"
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                  />
                </div>

                <div>
                  <label className="font-bold text-slate-200 block mb-1">Data da Compra *</label>
                  <input
                    type="date"
                    required
                    value={expCompetenceDate}
                    onChange={(e) => setExpCompetenceDate(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                  />
                </div>

                <div>
                  <label className="font-bold text-slate-200 block mb-1">Vencimento (Opcional)</label>
                  <input
                    type="date"
                    value={expDueDate}
                    onChange={(e) => setExpDueDate(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                  />
                </div>

                <div>
                  <label className="font-bold text-slate-200 block mb-1">Responsável pela Validação *</label>
                  <select
                    value={expResponsibleUid}
                    onChange={(e) => setExpResponsibleUid(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-white"
                  >
                    {members.map((m) => (
                      <option key={m.uid} value={m.uid}>
                        {m.displayName} {m.uid === userId ? '(Você)' : ''}
                      </option>
                    ))}
                  </select>
                  <p className="text-[10px] text-slate-400 mt-0.5">Autoridade com poder de aprovar/rejeitar.</p>
                </div>

                <div>
                  <label className="font-bold text-slate-200 block mb-1">Quem Desembolsou / Pagador *</label>
                  <select
                    value={expPayerUid}
                    onChange={(e) => setExpPayerUid(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-white"
                  >
                    {members.map((m) => (
                      <option key={m.uid} value={m.uid}>
                        {m.displayName} {m.uid === userId ? '(Você)' : ''}
                      </option>
                    ))}
                  </select>
                  <p className="text-[10px] text-slate-400 mt-0.5">Credor legítimo com direito aos reembolsos.</p>
                </div>
              </div>

              {/* Modalidade de Rateio */}
              <div className="pt-2 border-t border-slate-800">
                <label className="font-bold text-slate-200 block mb-2">Modalidade de Rateio *</label>
                <div className="grid grid-cols-3 gap-2">
                  <label
                    className={`border rounded-xl p-2.5 flex items-center gap-2 cursor-pointer ${
                      expSplitMethod === 'equal'
                        ? 'border-indigo-600 bg-indigo-50/30'
                        : 'border-slate-700'
                    }`}
                  >
                    <input
                      type="radio"
                      name="splitMethod"
                      value="equal"
                      checked={expSplitMethod === 'equal'}
                      onChange={() => setExpSplitMethod('equal')}
                    />
                    <div>
                      <div className="font-bold text-white">Igual (Equal)</div>
                      <div className="text-[10px] text-slate-400">Divisão exata de centavos</div>
                    </div>
                  </label>

                  <label
                    className={`border rounded-xl p-2.5 flex items-center gap-2 cursor-pointer ${
                      expSplitMethod === 'percentage'
                        ? 'border-indigo-600 bg-indigo-50/30'
                        : 'border-slate-700'
                    }`}
                  >
                    <input
                      type="radio"
                      name="splitMethod"
                      value="percentage"
                      checked={expSplitMethod === 'percentage'}
                      onChange={() => setExpSplitMethod('percentage')}
                    />
                    <div>
                      <div className="font-bold text-white">Percentual (%)</div>
                      <div className="text-[10px] text-slate-400">Soma de 100%</div>
                    </div>
                  </label>

                  <label
                    className={`border rounded-xl p-2.5 flex items-center gap-2 cursor-pointer ${
                      expSplitMethod === 'custom_value'
                        ? 'border-indigo-600 bg-indigo-50/30'
                        : 'border-slate-700'
                    }`}
                  >
                    <input
                      type="radio"
                      name="splitMethod"
                      value="custom_value"
                      checked={expSplitMethod === 'custom_value'}
                      onChange={() => setExpSplitMethod('custom_value')}
                    />
                    <div>
                      <div className="font-bold text-white">Personalizado (R$)</div>
                      <div className="text-[10px] text-slate-400">Valores fixos</div>
                    </div>
                  </label>
                </div>
              </div>

              {/* Participantes Selecionados */}
              <div className="pt-2 border-t border-slate-800">
                <label className="font-bold text-slate-200 block mb-2">
                  Participantes no Rateio ({selectedParticipants.length})
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {members
                    .filter((m) => m.participationStatus === 'active')
                    .map((m) => {
                      const isChecked = selectedParticipants.includes(m.uid);
                      return (
                        <div
                          key={m.uid}
                          className="flex items-center gap-2 border border-slate-700 rounded-xl p-2 bg-slate-800/50"
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedParticipants([...selectedParticipants, m.uid]);
                              } else {
                                setSelectedParticipants(
                                  selectedParticipants.filter((u) => u !== m.uid)
                                );
                              }
                            }}
                          />
                          <span className="font-medium text-white">{m.displayName}</span>

                          {expSplitMethod === 'percentage' && isChecked && (
                            <input
                              type="number"
                              placeholder="%"
                              value={customPercentages[m.uid] || ''}
                              onChange={(e) =>
                                setCustomPercentages({
                                  ...customPercentages,
                                  [m.uid]: parseFloat(e.target.value) || 0,
                                })
                              }
                              className="w-16 ml-auto bg-slate-800 border border-slate-700 text-white rounded px-1.5 py-0.5 text-right text-xs"
                            />
                          )}

                          {expSplitMethod === 'custom_value' && isChecked && (
                            <input
                              type="text"
                              placeholder="R$"
                              value={customValues[m.uid] || ''}
                              onChange={(e) =>
                                setCustomValues({
                                  ...customValues,
                                  [m.uid]: e.target.value,
                                })
                              }
                              className="w-20 ml-auto bg-slate-800 border border-slate-700 text-white rounded px-1.5 py-0.5 text-right text-xs"
                            />
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>

              {/* Pré-visualização do Rateio Matemático */}
              {liveSplitError ? (
                <div className="bg-rose-50 border border-rose-200 text-rose-700 p-2.5 rounded-xl text-xs">
                  {liveSplitError}
                </div>
              ) : liveSplitPreview.length > 0 ? (
                <div className="bg-emerald-50/40 border border-emerald-200 rounded-xl p-3 space-y-1.5">
                  <div className="font-bold text-emerald-800 flex items-center justify-between text-xs">
                    <span>Prévia do Rateio (Desvio Zero Centavos)</span>
                    <span className="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
                      ✓ Conservação Estrita
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-xs">
                    {liveSplitPreview.map((res) => (
                      <div key={res.memberUid} className="flex justify-between border-b border-emerald-100 pb-0.5">
                        <span className="text-slate-200">{res.memberName}:</span>
                        <strong className="text-white">
                          {formatCentsToBRL(res.assignedShareAmountCents)}
                        </strong>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsCreateExpenseModalOpen(false)}
                  className="px-4 py-2 border border-slate-700 text-slate-200 rounded-xl text-xs font-bold hover:bg-slate-800/80"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={Boolean(liveSplitError) || liveSplitPreview.length === 0}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 disabled:opacity-50"
                >
                  Confirmar e Criar Rateio
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================================== */}
      {/* MODAL 2: INFORMAR PAGAMENTO (DECLARAÇÃO PELO DEVEDOR)                      */}
      {/* ======================================================================== */}
      {isDeclareModalOpen && declExpense && declLiability && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-700 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">Informar Pagamento de Cota</h3>
              <button
                onClick={() => setIsDeclareModalOpen(false)}
                className="text-slate-400 hover:text-slate-300"
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            <form onSubmit={handleSubmitDeclaration} className="space-y-3 text-xs">
              <div>
                <span className="text-slate-400 block mb-0.5">Despesa:</span>
                <strong className="text-white block text-sm">{declExpense.title}</strong>
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Valor Pago (R$) *</label>
                <input
                  type="text"
                  required
                  value={declAmountInput}
                  onChange={(e) => setDeclAmountInput(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-bold text-white"
                />
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Data do Pagamento *</label>
                <input
                  type="date"
                  required
                  value={declDate}
                  onChange={(e) => setDeclDate(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                />
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Método de Pagamento *</label>
                <select
                  value={declMethod}
                  onChange={(e) => setDeclMethod(e.target.value as PaymentDeclarationMethod)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-white"
                >
                  <option value="pix">PIX</option>
                  <option value="bank_transfer">Transferência Bancária (TED/DOC)</option>
                  <option value="cash">Dinheiro em Espécie</option>
                  <option value="credit_card">Cartão de Crédito</option>
                  <option value="other">Outro</option>
                </select>
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Link do Comprovante (Opcional)</label>
                <input
                  type="url"
                  value={declProofUrl}
                  onChange={(e) => setDeclProofUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                />
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Observações (Opcional)</label>
                <textarea
                  value={declNotes}
                  onChange={(e) => setDeclNotes(e.target.value)}
                  placeholder="Ex: Transferido via Pix às 14h30"
                  rows={2}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsDeclareModalOpen(false)}
                  className="px-4 py-2 border border-slate-700 text-slate-200 rounded-xl text-xs font-bold hover:bg-slate-800/80"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700"
                >
                  Enviar Declaração
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================================== */}
      {/* MODAL 3: APROVAR PAGAMENTO (RESPONSÁVEL FINANCEIRO)                        */}
      {/* ======================================================================== */}
      {isApproveModalOpen && selectedDeclForApproval && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-700 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">Aprovar Pagamento de Rateio</h3>
              <button
                onClick={() => setIsApproveModalOpen(false)}
                className="text-slate-400 hover:text-slate-300"
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-700 space-y-1">
                <div>
                  Membro: <strong>{selectedDeclForApproval.memberName}</strong>
                </div>
                <div>
                  Valor Declarado:{' '}
                  <strong className="text-emerald-600 text-sm">
                    {formatCentsToBRL(selectedDeclForApproval.amountCents)}
                  </strong>
                </div>
                <div>Data informada: {selectedDeclForApproval.paymentDate}</div>
                <div>Método: {selectedDeclForApproval.paymentMethod.toUpperCase()}</div>
              </div>

              {(() => {
                const targetExp = expenses.find((e) => e.id === selectedDeclForApproval.expenseId);
                const beneficiaryUid = targetExp?.payerUid || targetExp?.responsibleUid;
                const beneficiaryName =
                  members.find((m) => m.uid === beneficiaryUid)?.displayName || beneficiaryUid;
                const isCreditorMe = beneficiaryUid === userId;

                if (!isCreditorMe) {
                  return (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[11px] text-amber-800 space-y-1">
                      <div className="font-bold flex items-center gap-1">
                        <i className="ph ph-info text-sm" />
                        Segregação de Beneficiário do Reembolso
                      </div>
                      <p>
                        O credor legítimo desta despesa é <strong>{beneficiaryName}</strong>.
                        O crédito financeiro pertence a ele(a). Como você está exercendo o papel de
                        validador(a), o valor não pode ser creditado na sua conta individual.
                      </p>
                    </div>
                  );
                }

                return (
                  <div>
                    <label className="font-bold text-slate-200 block mb-1">
                      Creditar na Conta Bancária (Opcional)
                    </label>
                    <select
                      value={selectedDestAccountId}
                      onChange={(e) => setSelectedDestAccountId(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-white"
                    >
                      <option value="">Não registrar crédito em conta agora</option>
                      {accounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.name} ({acc.type}) - Saldo: {formatCentsToBRL(acc.projectedBalanceCents)}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-slate-400 mt-1">
                      Selecione sua conta se deseja creditar este reembolso no seu saldo oficial.
                    </p>
                  </div>
                );
              })()}

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsApproveModalOpen(false)}
                  className="px-4 py-2 border border-slate-700 text-slate-200 rounded-xl text-xs font-bold hover:bg-slate-800/80"
                >
                  Voltar
                </button>
                <button
                  type="button"
                  onClick={handleConfirmApproval}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700"
                >
                  Confirmar e Aprovar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================================== */}
      {/* MODAL 4: REJEITAR PAGAMENTO                                                */}
      {/* ======================================================================== */}
      {isRejectModalOpen && selectedDeclForRejection && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-700 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">Rejeitar Pagamento</h3>
              <button
                onClick={() => setIsRejectModalOpen(false)}
                className="text-slate-400 hover:text-slate-300"
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <p className="text-slate-300">
                Informe o motivo pelo qual você não reconhece este pagamento de{' '}
                <strong>{formatCentsToBRL(selectedDeclForRejection.amountCents)}</strong> por{' '}
                <strong>{selectedDeclForRejection.memberName}</strong>.
              </p>

              <div>
                <label className="font-bold text-slate-200 block mb-1">
                  Justificativa Obrigatória *
                </label>
                <textarea
                  required
                  rows={3}
                  value={rejectionReasonInput}
                  onChange={(e) => setRejectionReasonInput(e.target.value)}
                  placeholder="Ex: O comprovante enviado está ilegível ou o valor não caiu na conta."
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsRejectModalOpen(false)}
                  className="px-4 py-2 border border-slate-700 text-slate-200 rounded-xl text-xs font-bold hover:bg-slate-800/80"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleConfirmRejection}
                  className="px-4 py-2 bg-rose-600 text-white rounded-xl text-xs font-bold hover:bg-rose-700"
                >
                  Confirmar Rejeição
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================================== */}
      {/* MODAL 5: REVOGAR APROVAÇÃO (HISTÓRICO IMUTÁVEL)                            */}
      {/* ======================================================================== */}
      {isRevokeModalOpen && selectedApprovalForRevocation && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-700 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">Revogar Aprovação de Pagamento</h3>
              <button
                onClick={() => setIsRevokeModalOpen(false)}
                className="text-slate-400 hover:text-slate-300"
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="bg-rose-50 border border-rose-200 text-rose-800 p-3 rounded-xl text-xs space-y-1">
                <strong>Atenção (Histórico Imutável & Ajuste Contábil):</strong> A revogação preserva integralmente o documento original de aprovação sem alterá-lo, registra um evento compensatório independente em <code>approval_revocations</code> e cria uma saída compensatória exclusivamente contábil (não realiza transferência bancária automática). Se o crédito já tiver sido utilizado, será registrada pendência de restituição financeira.
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">
                  Motivo da Revogação *
                </label>
                <textarea
                  required
                  rows={3}
                  value={revocationReasonInput}
                  onChange={(e) => setRevocationReasonInput(e.target.value)}
                  placeholder="Ex: Pagamento estornado pelo banco de origem após aprovação inicial."
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsRevokeModalOpen(false)}
                  className="px-4 py-2 border border-slate-700 text-slate-200 rounded-xl text-xs font-bold hover:bg-slate-800/80"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleConfirmRevocation}
                  className="px-4 py-2 bg-rose-600 text-white rounded-xl text-xs font-bold hover:bg-rose-700"
                >
                  Confirmar Revogação
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================================== */}
      {/* MODAL 6: REGISTRAR REEMBOLSO DE FORNECEDOR                                */}
      {/* ======================================================================== */}
      {isRefundModalOpen && selectedExpForRefund && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-700 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">Reembolso / Devolução Comercial</h3>
              <button
                onClick={() => setIsRefundModalOpen(false)}
                className="text-slate-400 hover:text-slate-300"
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <span className="text-slate-400 block">Despesa de Origem:</span>
                <strong className="text-white text-sm">{selectedExpForRefund.title}</strong>
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Tipo de Evento *</label>
                <select
                  value={refundType}
                  onChange={(e) => setRefundType(e.target.value as SupplierRefundType)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-white"
                >
                  <option value="partial_refund">Reembolso Parcial (Devolução parcial de valor)</option>
                  <option value="full_refund">Reembolso Total (Cancelamento integral da compra)</option>
                  <option value="unrecoverable_loss">Prejuízo Irrecuperável (Perda financeira sem retorno)</option>
                </select>
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Valor Devolvido (R$) *</label>
                <input
                  type="text"
                  value={refundAmountInput}
                  onChange={(e) => setRefundAmountInput(e.target.value)}
                  placeholder="Ex: 50,00"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-bold text-white"
                />
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Justificativa *</label>
                <textarea
                  required
                  rows={2}
                  value={refundJustification}
                  onChange={(e) => setRefundJustification(e.target.value)}
                  placeholder="Ex: Item devolvido por defeito; crédito em loja/estorno no cartão."
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsRefundModalOpen(false)}
                  className="px-4 py-2 border border-slate-700 text-slate-200 rounded-xl text-xs font-bold hover:bg-slate-800/80"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleConfirmRefund}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700"
                >
                  Registrar e Ajustar Cotas
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================================== */}
      {/* MODAL 7: CONFIRMAR RECEBIMENTO DE RESTITUIÇÃO                            */}
      {/* ======================================================================== */}
      {isConfirmRestitutionModalOpen && selectedRestitutionForConfirm && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-700 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">Confirmar Restituição Financeira</h3>
              <button
                onClick={() => setIsConfirmRestitutionModalOpen(false)}
                className="text-slate-400 hover:text-slate-300"
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            <form onSubmit={handleConfirmRestitution} className="space-y-3 text-xs">
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 p-3 rounded-xl text-xs space-y-1">
                <strong>Confirmação Oficial de Entrada:</strong> Ao confirmar, o valor recebido gerará uma entrada financeira oficial (movimento <code>inflow</code>) no livro-razão da sua conta bancária selecionada e abaterá o saldo pendente da restituição.
              </div>

              <div>
                <span className="text-slate-400 block">Saldo Pendente:</span>
                <strong className="text-white text-sm">
                  {formatCentsToBRL(selectedRestitutionForConfirm.remainingAmountCents)}
                </strong>
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Valor Recebido (R$) *</label>
                <input
                  type="text"
                  required
                  value={restitutionConfirmAmountInput}
                  onChange={(e) => setRestitutionConfirmAmountInput(e.target.value)}
                  placeholder="Ex: 50,00"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-bold text-white"
                />
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">
                  Conta Bancária de Destino *
                </label>
                <select
                  required
                  value={restitutionConfirmAccountId}
                  onChange={(e) => setRestitutionConfirmAccountId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-white"
                >
                  <option value="">Selecione a conta para crédito...</option>
                  {accounts
                    .filter((a) => !a.isArchived)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.type})
                      </option>
                    ))}
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsConfirmRestitutionModalOpen(false)}
                  className="px-4 py-2 border border-slate-700 text-slate-200 rounded-xl text-xs font-bold hover:bg-slate-800/80"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700"
                >
                  Confirmar e Creditar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================================== */}
      {/* MODAL 8: NOVA TRANSFERÊNCIA SOB CUSTÓDIA (FASE 7)                         */}
      {/* ======================================================================== */}
      {isCreateCustodyModalOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-700 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">Nova Transferência sob Custódia</h3>
              <button
                onClick={() => setIsCreateCustodyModalOpen(false)}
                className="text-slate-400 hover:text-slate-300"
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            <form onSubmit={handleCreateCustody} className="space-y-3 text-xs">
              <div className="bg-indigo-50 border border-indigo-200 text-indigo-900 p-3 rounded-xl text-xs space-y-1">
                <strong>Inexistência de Caixa Coletivo:</strong> O valor transferido sairá da sua conta e ficará sob a custódia do participante escolhido para utilização em despesas ou devolução futura.
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">
                  Participante Custodiante *
                </label>
                <select
                  required
                  value={custodyRecipientUid}
                  onChange={(e) => setCustodyRecipientUid(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-white"
                >
                  <option value="">Selecione quem custodiará o valor...</option>
                  {members
                    .filter((m) => m.uid !== userId && m.participationStatus === 'active')
                    .map((m) => (
                      <option key={m.uid} value={m.uid}>
                        {m.displayName} ({m.role})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Valor do Adiantamento (R$) *</label>
                <input
                  type="text"
                  required
                  value={custodyAmountInput}
                  onChange={(e) => setCustodyAmountInput(e.target.value)}
                  placeholder="Ex: 250,00"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-bold text-white"
                />
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">
                  Minha Conta Bancária de Saída *
                </label>
                <select
                  required
                  value={custodySourceAccountId}
                  onChange={(e) => setCustodySourceAccountId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-white"
                >
                  <option value="">Selecione a conta para débito...</option>
                  {accounts
                    .filter((a) => !a.isArchived && a.type !== 'credit')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.type})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Descrição / Finalidade *</label>
                <input
                  type="text"
                  required
                  value={custodyDescription}
                  onChange={(e) => setCustodyDescription(e.target.value)}
                  placeholder="Ex: Fundo adiantado para reservas"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                />
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Observações (Opcional)</label>
                <textarea
                  rows={2}
                  value={custodyNotes}
                  onChange={(e) => setCustodyNotes(e.target.value)}
                  placeholder="Instruções ou detalhes adicionais..."
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsCreateCustodyModalOpen(false)}
                  className="px-4 py-2 border border-slate-700 text-slate-200 rounded-xl text-xs font-bold hover:bg-slate-800/80"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700"
                >
                  Declarar Transferência
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================================== */}
      {/* MODAL 9: CONFIRMAR RECEBIMENTO DE CUSTÓDIA                                */}
      {/* ======================================================================== */}
      {isConfirmCustodyModalOpen && selectedCustodyTransfer && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-700 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">Confirmar Recebimento de Custódia</h3>
              <button
                onClick={() => setIsConfirmCustodyModalOpen(false)}
                className="text-slate-400 hover:text-slate-300"
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            <form onSubmit={handleConfirmCustody} className="space-y-3 text-xs">
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 p-3 rounded-xl text-xs space-y-1">
                <strong>Confirmação de Crédito:</strong> Ao confirmar, o valor recebido será creditado na sua conta bancária e o saldo ficará disponível para cobertura de despesas compartilhadas.
              </div>

              <div>
                <span className="text-slate-400 block">Valor Declarado pelo Remetente:</span>
                <strong className="text-white text-sm">
                  {formatCentsToBRL(selectedCustodyTransfer.initialAmountCents)}
                </strong>
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">
                  Conta Bancária de Destino (Sua Conta) *
                </label>
                <select
                  required
                  value={custodyDestAccountId}
                  onChange={(e) => setCustodyDestAccountId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-white"
                >
                  <option value="">Selecione onde o dinheiro entrou...</option>
                  {accounts
                    .filter((a) => !a.isArchived && a.type !== 'credit')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.type})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Valor Efetivamente Recebido (R$)</label>
                <input
                  type="text"
                  required
                  value={custodyConfirmAmountInput}
                  onChange={(e) => setCustodyConfirmAmountInput(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-bold text-white"
                />
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Observações (Opcional)</label>
                <input
                  type="text"
                  value={custodyConfirmNotes}
                  onChange={(e) => setCustodyConfirmNotes(e.target.value)}
                  placeholder="Ex: Recebido via Pix no Nubank"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsConfirmCustodyModalOpen(false)}
                  className="px-4 py-2 border border-slate-700 text-slate-200 rounded-xl text-xs font-bold hover:bg-slate-800/80"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700"
                >
                  Confirmar e Disponibilizar Saldo
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================================== */}
      {/* MODAL 10: DECLARAR DEVOLUÇÃO DE RECURSOS SOB CUSTÓDIA                     */}
      {/* ======================================================================== */}
      {isReturnCustodyModalOpen && selectedCustodyTransfer && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-700 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">Declarar Devolução de Custódia</h3>
              <button
                onClick={() => setIsReturnCustodyModalOpen(false)}
                className="text-slate-400 hover:text-slate-300"
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            <form onSubmit={handleDeclareCustodyReturn} className="space-y-3 text-xs">
              <div className="bg-indigo-50 border border-indigo-200 text-indigo-900 p-3 rounded-xl text-xs space-y-1">
                <strong>Devolução de Saldo Não Utilizado (Etapa 1):</strong> Ao declarar a devolução, o valor será reservado e ficará aguardando a confirmação de recebimento pelo remetente original.
              </div>

              <div>
                <span className="text-slate-400 block">Saldo Disponível para Devolução:</span>
                <strong className="text-emerald-700 text-sm">
                  {formatCentsToBRL(selectedCustodyTransfer.availableBalanceCents)}
                </strong>
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">
                  Sua Conta Bancária de Saída *
                </label>
                <select
                  required
                  value={custodyReturnSourceAccountId}
                  onChange={(e) => setCustodyReturnSourceAccountId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-white"
                >
                  <option value="">Selecione sua conta para débito...</option>
                  {accounts
                    .filter((a) => !a.isArchived && a.type !== 'credit')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.type})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Valor da Devolução (R$) *</label>
                <input
                  type="text"
                  required
                  value={custodyReturnAmountInput}
                  onChange={(e) => setCustodyReturnAmountInput(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-bold text-white"
                />
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Justificativa da Devolução (Opcional)</label>
                <textarea
                  rows={2}
                  value={custodyReturnJustification}
                  onChange={(e) => setCustodyReturnJustification(e.target.value)}
                  placeholder="Ex: Saldo não utilizado após a conclusão das compras."
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsReturnCustodyModalOpen(false)}
                  className="px-4 py-2 border border-slate-700 text-slate-200 rounded-xl text-xs font-bold hover:bg-slate-800/80"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 disabled:opacity-50"
                >
                  {loading ? 'Declarando...' : 'Declarar Devolução'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================================== */}
      {/* MODAL 11: CONFIRMAR RECEBIMENTO DE DEVOLUÇÃO DE CUSTÓDIA                  */}
      {/* ======================================================================== */}
      {isConfirmCustodyReturnModalOpen && selectedCustodyTransfer && selectedCustodyReturnRecord && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-700 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">Confirmar Recebimento de Devolução</h3>
              <button
                onClick={() => setIsConfirmCustodyReturnModalOpen(false)}
                className="text-slate-400 hover:text-slate-300"
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            <form onSubmit={handleConfirmCustodyReturnReceipt} className="space-y-3 text-xs">
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 p-3 rounded-xl text-xs space-y-1">
                <strong>Confirmação de Crédito (Etapa 2):</strong> O custodiante declarou a devolução dos recursos. Ao confirmar, o valor será creditado na sua conta bancária e baixado da custódia.
              </div>

              <div>
                <span className="text-slate-400 block">Valor Devolvido Declarado:</span>
                <strong className="text-emerald-700 text-sm">
                  {formatCentsToBRL(selectedCustodyReturnRecord.amountCents)}
                </strong>
                {selectedCustodyReturnRecord.justification && (
                  <p className="text-[11px] text-slate-400 mt-1 italic">
                    Justificativa: {selectedCustodyReturnRecord.justification}
                  </p>
                )}
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">
                  Sua Conta Bancária de Destino *
                </label>
                <select
                  required
                  value={custodyConfirmReturnDestAccountId}
                  onChange={(e) => setCustodyConfirmReturnDestAccountId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-white"
                >
                  <option value="">Selecione onde o dinheiro entrou...</option>
                  {accounts
                    .filter((a) => !a.isArchived && a.type !== 'credit')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.type})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="font-bold text-slate-200 block mb-1">Observações (Opcional)</label>
                <input
                  type="text"
                  value={custodyConfirmReturnNotes}
                  onChange={(e) => setCustodyConfirmReturnNotes(e.target.value)}
                  placeholder="Ex: Recebido via Pix no Santander"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsConfirmCustodyReturnModalOpen(false)}
                  className="px-4 py-2 border border-slate-700 text-slate-200 rounded-xl text-xs font-bold hover:bg-slate-800/80"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700 disabled:opacity-50"
                >
                  {loading ? 'Confirmando...' : 'Confirmar e Creditar Saldo'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================================== */}
      {/* MODAL 12: ESTORNAR RECEBIMENTO DE RESTITUIÇÃO                            */}
      {/* ======================================================================== */}
      {isReverseRestitutionModalOpen && selectedRestitutionForReverse && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-700 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">Estornar Recebimento de Restituição</h3>
              <button
                onClick={() => setIsReverseRestitutionModalOpen(false)}
                className="text-slate-400 hover:text-slate-300"
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            <form onSubmit={handleReverseRestitution} className="space-y-3 text-xs">
              <div className="bg-amber-50 border border-amber-200 text-amber-900 p-3 rounded-xl text-xs space-y-1">
                <strong>Atenção:</strong> O estorno irá registrar um movimento financeiro compensatório de saída e restaurará o saldo pendente de restituição do devedor.
              </div>

              <div>
                <span className="text-slate-400 block">Total Já Restituído:</span>
                <strong className="text-white text-sm">
                  {formatCentsToBRL(selectedRestitutionForReverse.restitutedAmountCents)}
                </strong>
              </div>

              {restitutionReceiptsList.length > 1 && (
                <div>
                  <label className="font-bold text-slate-200 block mb-1">
                    Recibo a Estornar *
                  </label>
                  <select
                    required
                    value={selectedRestitutionReceiptId}
                    onChange={(e) => setSelectedRestitutionReceiptId(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-white"
                  >
                    {restitutionReceiptsList.map((rc) => (
                      <option key={rc.id} value={rc.id}>
                        {formatCentsToBRL(rc.amountCents)} ({new Date(rc.createdAt).toLocaleDateString()}) - {rc.id}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="font-bold text-slate-200 block mb-1">
                  Motivo do Estorno *
                </label>
                <textarea
                  required
                  rows={2}
                  value={restitutionReverseReason}
                  onChange={(e) => setRestitutionReverseReason(e.target.value)}
                  placeholder="Ex: Confirmação indevida; transferência Pix não identificada no extrato."
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsReverseRestitutionModalOpen(false)}
                  className="px-4 py-2 border border-slate-700 text-slate-200 rounded-xl text-xs font-bold hover:bg-slate-800/80"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold shadow-xs disabled:opacity-50"
                >
                  {loading ? 'Estornando...' : 'Confirmar Estorno'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
