import React, { useEffect, useState } from 'react';
import { Space, SpaceParticipant, Transaction, TransactionType } from '../types/finance';
import {
  addMonthsToYearMonth,
  calculateSpaceLedger,
  formatCurrency,
} from '../utils/financeEngine';
import {
  getEmailJSConfig,
  getSentEmailLogs,
  saveEmailJSConfig,
  sendTransactionalEmail,
} from '../services/emailService';

const MONTH_NAMES_PT: Record<string, string> = {
  '01': 'Janeiro',
  '02': 'Fevereiro',
  '03': 'Março',
  '04': 'Abril',
  '05': 'Maio',
  '06': 'Junho',
  '07': 'Julho',
  '08': 'Agosto',
  '09': 'Setembro',
  '10': 'Outubro',
  '11': 'Novembro',
  '12': 'Dezembro',
};

function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  return `${MONTH_NAMES_PT[m] || m} ${y}`;
}

interface SpacesLedgerViewProps {
  spaces: Space[];
  transactions: Transaction[];
  selectedMonth: string; // YYYY-MM
  onChangeMonth?: (newMonth: string) => void;
  userEmail: string;
  userName: string;
  activeLedgerSpace: Space | null;
  onSetActiveLedgerSpace: (sp: Space | null) => void;
  onCreateSpace: (
    sp: Omit<Space, 'id' | 'ownerId' | 'ownerEmail'>
  ) => Promise<void>;
  onUpdateSpace: (
    spaceId: string,
    sp: Omit<Space, 'id' | 'ownerId' | 'ownerEmail'>
  ) => Promise<void>;
  onDeleteSpace: (spaceId: string) => Promise<void>;
  onInviteToSpace: (spaceId: string, email: string, name: string) => Promise<void>;
  onSettleTransfer: (
    space: Space,
    fromEmail: string,
    fromName: string,
    toEmail: string,
    toName: string,
    amount: number
  ) => Promise<void>;
  onConfirmSpaceIncome: (tx: Transaction) => Promise<void>;
  onSettleSpaceExpense: (
    tx: Transaction,
    mode: 'space_cash' | 'member_direct',
    payerEmail?: string
  ) => Promise<void>;
  onOpenNewTransactionInSpace: (
    spaceId: string,
    presetType?: TransactionType
  ) => void;
  onSelectTransaction: (tx: Transaction) => void;
  onNotifyToast: (msg: string) => void;
}

export const SpacesLedgerView: React.FC<SpacesLedgerViewProps> = ({
  spaces,
  transactions,
  selectedMonth,
  onChangeMonth,
  userEmail,
  userName,
  activeLedgerSpace,
  onSetActiveLedgerSpace,
  onCreateSpace,
  onUpdateSpace,
  onDeleteSpace,
  onInviteToSpace,
  onSettleTransfer,
  onConfirmSpaceIncome,
  onSettleSpaceExpense,
  onOpenNewTransactionInSpace,
  onSelectTransaction,
  onNotifyToast,
}) => {
  const [isSpaceModalOpen, setIsSpaceModalOpen] = useState(false);
  const [editingSpace, setEditingSpace] = useState<Space | null>(null);
  const [deletingSpace, setDeletingSpace] = useState<Space | null>(null);
  const [spaceName, setSpaceName] = useState('');
  const [spaceDesc, setSpaceDesc] = useState('');
  const [spaceIcon, setSpaceIcon] = useState('ph-house-line');
  const [spaceColor, setSpaceColor] = useState('indigo');
  const [inviteEmailsRaw, setInviteEmailsRaw] = useState('');
  const [editingParticipants, setEditingParticipants] = useState<SpaceParticipant[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Convite avulso em um espaço existente
  const [inviteModalSpace, setInviteModalSpace] = useState<Space | null>(null);
  const [singleInviteName, setSingleInviteName] = useState('');
  const [singleInviteEmail, setSingleInviteEmail] = useState('');

  // Configuração opcional EmailJS
  const [showEmailJsModal, setShowEmailJsModal] = useState(false);
  const existingCfg = getEmailJSConfig();
  const [serviceId, setServiceId] = useState(existingCfg.serviceId);
  const [templateId, setTemplateId] = useState(existingCfg.templateId);
  const [publicKey, setPublicKey] = useState(existingCfg.publicKey);

  // Trava a rolagem do body quando a gaveta do Livro-Razão ou qualquer modal está aberto (evita barra de rolagem dupla)
  useEffect(() => {
    const anyOpen = Boolean(
      activeLedgerSpace ||
        isSpaceModalOpen ||
        deletingSpace ||
        inviteModalSpace ||
        showEmailJsModal
    );
    if (!anyOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [
    activeLedgerSpace,
    isSpaceModalOpen,
    deletingSpace,
    inviteModalSpace,
    showEmailJsModal,
  ]);

  const handleOpenCreateModal = () => {
    setEditingSpace(null);
    setFormError(null);
    setSpaceName('');
    setSpaceDesc('');
    setSpaceIcon('ph-house-line');
    setSpaceColor('indigo');
    setInviteEmailsRaw('');
    setEditingParticipants([]);
    setIsSpaceModalOpen(true);
  };

  const handleOpenEditModal = (sp: Space) => {
    setEditingSpace(sp);
    setFormError(null);
    setSpaceName(sp.name);
    setSpaceDesc(sp.description);
    setSpaceIcon(sp.icon || 'ph-house-line');
    setSpaceColor(sp.color || 'indigo');
    setInviteEmailsRaw('');
    setEditingParticipants(sp.participants || []);
    setIsSpaceModalOpen(true);
  };

  const handleRemoveParticipantFromEdit = (emailToRemove: string) => {
    if (emailToRemove.toLowerCase() === userEmail.toLowerCase()) return;
    setEditingParticipants((prev) =>
      prev.filter((p) => p.email.toLowerCase() !== emailToRemove.toLowerCase())
    );
  };

  const handleSpaceFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!spaceName.trim()) {
      setFormError('Informe o nome do espaço compartilhado (ex: Casa, Viagem).');
      return;
    }

    const parsedInvites = inviteEmailsRaw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes('@') && s !== userEmail.toLowerCase());

    setSubmitting(true);
    try {
      if (editingSpace) {
        const baseParts =
          editingParticipants.length > 0
            ? [...editingParticipants]
            : [
                {
                  email: userEmail.toLowerCase(),
                  name: userName,
                  status: 'active' as const,
                },
              ];

        for (const invEmail of parsedInvites) {
          if (!baseParts.some((p) => p.email.toLowerCase() === invEmail)) {
            baseParts.push({
              email: invEmail,
              name: invEmail.split('@')[0],
              status: 'invited',
            });
          }
        }

        const finalParticipants = baseParts.slice(0, 20);
        const finalEmails = Array.from(
          new Set([
            userEmail.toLowerCase(),
            ...finalParticipants.map((p) => p.email.toLowerCase()),
          ])
        ).slice(0, 20);

        await onUpdateSpace(editingSpace.id, {
          name: spaceName.trim().slice(0, 80),
          description: spaceDesc.trim().slice(0, 240) || 'Espaço compartilhado',
          icon: spaceIcon,
          color: spaceColor,
          participantEmails: finalEmails,
          participants: finalParticipants,
        });

        for (const invEmail of parsedInvites) {
          await sendTransactionalEmail({
            toEmail: invEmail,
            toName: invEmail.split('@')[0],
            fromName: userName,
            subject: `Convite para o Espaço Compartilhado: ${spaceName.trim()}`,
            spaceOrTransactionTitle: spaceName.trim(),
            message: `${userName} adicionou você ao espaço "${spaceName.trim()}" no Meu Painel Financeiro.`,
            type: 'space_invite',
          });
        }
      } else {
        const participantEmails = Array.from(
          new Set([userEmail.toLowerCase(), ...parsedInvites])
        ).slice(0, 20);

        const participants: SpaceParticipant[] = [
          { email: userEmail.toLowerCase(), name: userName, status: 'active' as const },
          ...parsedInvites.map((em) => ({
            email: em,
            name: em.split('@')[0],
            status: 'invited' as const,
          })),
        ].slice(0, 20);

        await onCreateSpace({
          name: spaceName.trim().slice(0, 80),
          description: spaceDesc.trim().slice(0, 240) || 'Espaço compartilhado',
          icon: spaceIcon,
          color: spaceColor,
          participantEmails,
          participants,
        });

        for (const invEmail of parsedInvites) {
          await sendTransactionalEmail({
            toEmail: invEmail,
            toName: invEmail.split('@')[0],
            fromName: userName,
            subject: `Convite para o Espaço Compartilhado: ${spaceName.trim()}`,
            spaceOrTransactionTitle: spaceName.trim(),
            message: `${userName} convidou você para dividir e auditar despesas no espaço "${spaceName.trim()}" no Meu Painel Financeiro.`,
            type: 'space_invite',
          });
        }

        if (parsedInvites.length > 0) {
          onNotifyToast(
            `Espaço criado e ${parsedInvites.length} convite(s) enviado(s) por e-mail.`
          );
        }
      }

      setSpaceName('');
      setSpaceDesc('');
      setInviteEmailsRaw('');
      setEditingSpace(null);
      setIsSpaceModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDeleteSpace = async () => {
    if (!deletingSpace) return;
    setSubmitting(true);
    try {
      await onDeleteSpace(deletingSpace.id);
      setDeletingSpace(null);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSingleInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteModalSpace) return;
    if (!singleInviteEmail.trim() || !singleInviteEmail.includes('@')) return;

    await onInviteToSpace(
      inviteModalSpace.id,
      singleInviteEmail.trim().toLowerCase(),
      singleInviteName.trim() || singleInviteEmail.trim().split('@')[0]
    );

    const res = await sendTransactionalEmail({
      toEmail: singleInviteEmail.trim().toLowerCase(),
      toName: singleInviteName.trim() || singleInviteEmail.trim().split('@')[0],
      fromName: userName,
      subject: `Convite para o Espaço "${inviteModalSpace.name}"`,
      spaceOrTransactionTitle: inviteModalSpace.name,
      message: `Você foi convidado por ${userName} para participar do Livro-Razão do espaço "${inviteModalSpace.name}".`,
      type: 'space_invite',
    });

    onNotifyToast(res.message);
    setSingleInviteEmail('');
    setSingleInviteName('');
    setInviteModalSpace(null);
  };

  const sentLogs = getSentEmailLogs();

  return (
    <div className="space-y-8">
      {/* Cabeçalho */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h2 className="text-xl font-bold text-white">
              Espaços Compartilhados & Livro-Razão
            </h2>
            <span className="px-2.5 py-0.5 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-xs font-mono font-bold">
              Mês: {formatMonthLabel(selectedMonth)} ({selectedMonth})
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Despesas do mês entram negativamente com rateio igual (ou % opcional); aportes de receita abatem sua dívida, formam o caixa do espaço e mostram o % coberto por cada membro.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => setShowEmailJsModal(true)}
            className="px-3.5 py-2.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold rounded-xl flex items-center gap-2 cursor-pointer whitespace-nowrap"
          >
            <i className="ph-fill ph-envelope-simple-open text-indigo-400"></i>
            <span>Notificações EmailJS ({sentLogs.length})</span>
          </button>

          <button
            type="button"
            onClick={handleOpenCreateModal}
            className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-lg shadow-indigo-600/20 flex items-center gap-2 cursor-pointer whitespace-nowrap"
          >
            <i className="ph-bold ph-plus"></i>
            <span>Novo Espaço</span>
          </button>
        </div>
      </div>

      {/* Cards de Espaços Compartilhados (Apurados por Mês Selecionado) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {spaces.map((space) => {
          const spaceTxs = transactions.filter(
            (tx) => tx.spaceId === space.id && tx.invoiceMonth === selectedMonth
          );
          const ledger = calculateSpaceLedger(spaceTxs, space.participants);
          const mySummary = ledger.summaries.find(
            (s) => s.email.toLowerCase() === userEmail.toLowerCase()
          );

          return (
            <div
              key={space.id}
              className="bg-slate-800 border border-slate-700/80 hover:border-indigo-500/40 rounded-3xl p-4 sm:p-6 flex flex-col justify-between transition-all"
            >
              <div>
                <div className="flex items-start justify-between gap-3 mb-5">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 flex items-center justify-center shrink-0">
                      <i className={`ph-fill ${space.icon || 'ph-users-three'} text-xl sm:text-2xl`}></i>
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-base sm:text-lg font-bold text-white truncate">
                        {space.name}
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">
                        {space.description}
                      </p>
                    </div>
                  </div>

                  {/* Ações do Espaço: Convidar, Editar e Excluir */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => setInviteModalSpace(space)}
                      aria-label={`Convidar por e-mail para ${space.name}`}
                      title="Convidar participante por e-mail"
                      className="px-2.5 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-indigo-300 flex items-center gap-1.5 cursor-pointer"
                    >
                      <i className="ph-bold ph-user-plus" aria-hidden="true"></i>
                      <span className="hidden sm:inline">Convidar</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenEditModal(space)}
                      aria-label={`Editar espaço ${space.name}`}
                      title="Editar Espaço"
                      className="w-8 h-8 rounded-xl bg-slate-900/90 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/80 flex items-center justify-center transition-colors cursor-pointer"
                    >
                      <i className="ph-bold ph-pencil-simple text-sm" aria-hidden="true"></i>
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeletingSpace(space)}
                      aria-label={`Excluir espaço ${space.name}`}
                      title="Excluir Espaço"
                      className="w-8 h-8 rounded-xl bg-slate-900/90 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 border border-slate-700/80 hover:border-rose-500/30 flex items-center justify-center transition-colors cursor-pointer"
                    >
                      <i className="ph-bold ph-trash text-sm" aria-hidden="true"></i>
                    </button>
                  </div>
                </div>

                {/* Resumo Mensal do Espaço (Despesas Negativas, Receitas/Caixa e Cobertura) */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-3.5 sm:p-4 rounded-2xl bg-slate-900/70 border border-slate-700/60 mb-4">
                  <div>
                    <span className="text-[11px] text-slate-400 block">
                      Despesas ({selectedMonth})
                    </span>
                    <span className="text-sm font-bold text-rose-400 font-mono tabular-nums mt-0.5 block">
                      -{formatCurrency(ledger.totalSharedExpenses)}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono block">
                      A pagar: {formatCurrency(ledger.pendingExpenses)}
                    </span>
                  </div>

                  <div>
                    <span className="text-[11px] text-slate-400 block">
                      Aportes / Caixa
                    </span>
                    <span className="text-sm font-bold text-emerald-400 font-mono tabular-nums mt-0.5 block">
                      +{formatCurrency(ledger.totalConfirmedIncome)}
                    </span>
                    <span className="text-[10px] text-indigo-300 font-mono block">
                      Caixa: {formatCurrency(ledger.availableSpaceCash)}
                    </span>
                  </div>

                  <div>
                    <span className="text-[11px] text-slate-400 block">
                      Sua Cota ({mySummary ? `${mySummary.responsibilityPercent.toFixed(0)}%` : '0%'})
                    </span>
                    <span className="text-sm font-bold text-slate-200 font-mono tabular-nums mt-0.5 block">
                      {formatCurrency(mySummary?.totalResponsibility || 0)}
                    </span>
                    <span className="text-[10px] text-indigo-300 font-mono block">
                      Você cobriu: {(mySummary?.coveragePercent || 0).toFixed(0)}%
                    </span>
                  </div>

                  <div className="sm:text-right">
                    <span className="text-[11px] text-slate-400 block">
                      Seu Saldo no Mês
                    </span>
                    <span
                      className={`text-sm font-bold font-mono tabular-nums mt-0.5 block ${
                        (mySummary?.netBalance || 0) >= 0
                          ? 'text-emerald-400'
                          : 'text-rose-400'
                      }`}
                    >
                      {(mySummary?.netBalance || 0) >= 0 ? 'A Receber ' : 'A Pagar '}
                      {formatCurrency(Math.abs(mySummary?.netBalance || 0))}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono block">
                      Pago/Aportado: {formatCurrency(mySummary?.totalPaid || 0)}
                    </span>
                  </div>
                </div>

                {/* Participantes e % Coberto no Mês */}
                <div className="mb-5">
                  <span className="text-xs font-semibold text-slate-400 block mb-2">
                    Cobertura dos Participantes no Mês ({space.participants.length})
                  </span>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                    {ledger.summaries.map((sum) => {
                      const partObj = space.participants.find(
                        (p) => p.email.toLowerCase() === sum.email.toLowerCase()
                      );
                      const isInvited = partObj?.status === 'invited';
                      return (
                        <div
                          key={sum.email}
                          className="px-2.5 py-1 rounded-xl bg-slate-900/80 border border-slate-700/70 flex items-center gap-1.5"
                        >
                          <span className="font-semibold text-white">{sum.name}</span>
                          {isInvited && (
                            <span className="px-1.5 py-0.2 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] font-semibold">
                              Pendente
                            </span>
                          )}
                          <span className="text-[11px] font-mono text-indigo-300">
                            {sum.coveragePercent.toFixed(0)}% coberto
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-slate-700/60 flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    aria-label={`Nova Despesa em ${space.name}`}
                    onClick={() => onOpenNewTransactionInSpace(space.id, 'expense')}
                    className="px-3 py-1.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
                  >
                    <i className="ph-bold ph-minus-circle"></i>
                    <span>+ Despesa</span>
                  </button>

                  <button
                    type="button"
                    aria-label={`Enviar Receita para ${space.name}`}
                    onClick={() => onOpenNewTransactionInSpace(space.id, 'income')}
                    className="px-3 py-1.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
                  >
                    <i className="ph-bold ph-hand-coins"></i>
                    <span>+ Enviar Receita</span>
                  </button>
                </div>

                <button
                  type="button"
                  aria-label={`Abrir Gaveta de Auditoria de ${space.name}`}
                  onClick={() => onSetActiveLedgerSpace(space)}
                  className="px-4 py-2 rounded-xl bg-indigo-600/25 hover:bg-indigo-600/35 border border-indigo-500/40 text-indigo-200 text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors"
                >
                  <i className="ph-fill ph-scales"></i>
                  <span>Abrir Gaveta de Auditoria (Livro-Razão)</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Gaveta de Auditoria (Livro-Razão Mensal com Caixa do Espaço, Receitas e Baixa de Despesas) */}
      {activeLedgerSpace && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/80 backdrop-blur-xs flex justify-end"
          role="dialog"
          aria-modal="true"
          aria-label={`Livro-Razão de ${activeLedgerSpace.name}`}
          onClick={() => onSetActiveLedgerSpace(null)}
        >
          <div
            className="w-full max-w-2xl bg-slate-900 border-l border-slate-800 h-dvh flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Topo Fixo do Drawer com Alternador de Mês do Livro-Razão */}
            <div className="p-4 sm:p-6 pb-4 border-b border-slate-800 space-y-3 shrink-0">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-2xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
                    <i className="ph-fill ph-scales text-xl sm:text-2xl"></i>
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-base sm:text-lg font-bold text-white truncate">
                      Livro-Razão Mensal: {activeLedgerSpace.name}
                    </h3>
                    <p className="text-xs text-slate-400">
                      Despesas negativas, aportes de receita, cobertura (%) e baixa de contas no mês
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleOpenEditModal(activeLedgerSpace)}
                    aria-label={`Editar espaço ${activeLedgerSpace.name} na gaveta`}
                    className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                  >
                    <i className="ph-bold ph-pencil-simple" aria-hidden="true"></i>
                    <span className="hidden sm:inline">Editar</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onSetActiveLedgerSpace(null)}
                    aria-label="Fechar Livro-Razão"
                    className="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center cursor-pointer"
                  >
                    <i className="ph-bold ph-x" aria-hidden="true"></i>
                  </button>
                </div>
              </div>

              {/* Seletor de Mês + Ações Rápidas dentro do próprio Livro-Razão */}
              <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-800/90 border border-slate-700/80 px-3 py-2 rounded-2xl">
                <div className="flex items-center gap-1.5">
                  {onChangeMonth && (
                    <button
                      type="button"
                      onClick={() =>
                        onChangeMonth(addMonthsToYearMonth(selectedMonth, -1))
                      }
                      aria-label="Mês anterior no Livro-Razão"
                      className="w-7 h-7 rounded-xl bg-slate-900 hover:bg-slate-700 text-slate-200 flex items-center justify-center cursor-pointer"
                    >
                      <i className="ph-bold ph-caret-left text-xs"></i>
                    </button>
                  )}
                  <span className="px-2.5 py-1 rounded-xl bg-slate-900 border border-slate-700 text-xs font-bold text-emerald-300 font-mono whitespace-nowrap">
                    {formatMonthLabel(selectedMonth)} ({selectedMonth})
                  </span>
                  {onChangeMonth && (
                    <button
                      type="button"
                      onClick={() =>
                        onChangeMonth(addMonthsToYearMonth(selectedMonth, 1))
                      }
                      aria-label="Próximo mês no Livro-Razão"
                      className="w-7 h-7 rounded-xl bg-slate-900 hover:bg-slate-700 text-slate-200 flex items-center justify-center cursor-pointer"
                    >
                      <i className="ph-bold ph-caret-right text-xs"></i>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      onOpenNewTransactionInSpace(activeLedgerSpace.id, 'expense')
                    }
                    className="px-2.5 py-1.5 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/30 text-rose-200 text-[11px] font-bold flex items-center gap-1 cursor-pointer"
                  >
                    <i className="ph-bold ph-minus-circle"></i>
                    <span>+ Despesa</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onOpenNewTransactionInSpace(activeLedgerSpace.id, 'income')
                    }
                    className="px-2.5 py-1.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 text-emerald-200 text-[11px] font-bold flex items-center gap-1 cursor-pointer"
                  >
                    <i className="ph-bold ph-hand-coins"></i>
                    <span>+ Enviar Receita</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Corpo Rolável Único do Livro-Razão (Filtrado pelo Mês Selecionado) */}
            <div className="p-4 sm:p-6 overflow-y-auto flex-1 overscroll-contain">
              {(() => {
                const spaceTxs = transactions.filter(
                  (tx) =>
                    tx.spaceId === activeLedgerSpace.id &&
                    tx.invoiceMonth === selectedMonth
                );
                const ledger = calculateSpaceLedger(
                  spaceTxs,
                  activeLedgerSpace.participants
                );
                const incomeTxs = spaceTxs.filter(
                  (tx) => tx.type === 'income' && tx.status !== 'rejected'
                );
                const expenseTxs = spaceTxs.filter(
                  (tx) => tx.type === 'expense' && tx.status !== 'rejected'
                );

                return (
                  <div className="space-y-6">
                    {/* Painel de Caixa Mensal do Espaço */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3.5 rounded-2xl bg-slate-800/90 border border-slate-700/80">
                      <div className="p-2.5 rounded-xl bg-slate-900/70 border border-slate-800">
                        <span className="text-[11px] text-slate-400 block">
                          Despesas em {formatMonthLabel(selectedMonth)}
                        </span>
                        <span className="text-base font-bold text-rose-400 font-mono tabular-nums mt-0.5 block">
                          -{formatCurrency(ledger.totalSharedExpenses)}
                        </span>
                        <div className="text-[10px] text-slate-400 font-mono mt-1 flex items-center justify-between">
                          <span>Pagas: {formatCurrency(ledger.settledExpenses)}</span>
                          <span className="text-amber-300">
                            A pagar: {formatCurrency(ledger.pendingExpenses)}
                          </span>
                        </div>
                      </div>

                      <div className="p-2.5 rounded-xl bg-slate-900/70 border border-slate-800">
                        <span className="text-[11px] text-slate-400 block">
                          Receitas / Aportes Confirmados
                        </span>
                        <span className="text-base font-bold text-emerald-400 font-mono tabular-nums mt-0.5 block">
                          +{formatCurrency(ledger.totalConfirmedIncome)}
                        </span>
                        <div className="text-[10px] text-slate-400 font-mono mt-1 flex items-center justify-between">
                          <span>
                            Usado p/ baixa: {formatCurrency(ledger.paidViaSpaceCashExpenses)}
                          </span>
                          {ledger.totalPendingIncome > 0 && (
                            <span className="text-amber-300">
                              Agend.: +{formatCurrency(ledger.totalPendingIncome)}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="p-2.5 rounded-xl bg-indigo-950/40 border border-indigo-500/30">
                        <span className="text-[11px] text-indigo-300 font-semibold block">
                          Saldo Disponível no Caixa
                        </span>
                        <span
                          className={`text-base font-bold font-mono tabular-nums mt-0.5 block ${
                            ledger.availableSpaceCash >= 0
                              ? 'text-indigo-200'
                              : 'text-rose-300'
                          }`}
                        >
                          {formatCurrency(ledger.availableSpaceCash)}
                        </span>
                        <span className="text-[10px] text-slate-400 block mt-1">
                          Para dar baixa nas despesas do mês
                        </span>
                      </div>
                    </div>

                    {/* 1. Relatório de Cobertura Percentual (%) & Balanço por Participante */}
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <h4 className="text-xs font-bold text-slate-200">
                          1. Relatório de Cobertura (%) e Pagamentos em {formatMonthLabel(selectedMonth)}
                        </h4>
                        <span className="text-[11px] text-slate-400 font-mono">
                          Quem pagou o quê & % coberto
                        </span>
                      </div>

                      <div className="space-y-3">
                        {ledger.summaries.map((sum) => {
                          const coveredMoreThanFairShare =
                            sum.coveragePercent > sum.responsibilityPercent + 0.5;
                          return (
                            <div
                              key={sum.email}
                              className="p-4 rounded-2xl bg-slate-800 border border-slate-700/80 space-y-3 text-xs"
                            >
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-bold text-white text-sm">
                                      {sum.name}
                                    </span>
                                    <span className="px-2 py-0.5 rounded-md bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 font-mono text-[11px] font-bold">
                                      Cobriu {sum.coveragePercent.toFixed(1)}% do mês
                                    </span>
                                    {coveredMoreThanFairShare && (
                                      <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[10px] font-semibold">
                                        Cobriu despesa de outros (+
                                        {(
                                          sum.coveragePercent -
                                          sum.responsibilityPercent
                                        ).toFixed(1)}
                                        %)
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                                    {sum.email} · Cota de responsabilidade:{' '}
                                    {sum.responsibilityPercent.toFixed(1)}%
                                  </div>
                                </div>

                                <div className="text-right font-mono tabular-nums">
                                  <span
                                    className={`text-xs font-bold px-2.5 py-1 rounded-xl inline-block ${
                                      sum.netBalance > 0.01
                                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                                        : sum.netBalance < -0.01
                                        ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                                        : 'bg-slate-700/60 text-slate-300'
                                    }`}
                                  >
                                    {sum.netBalance > 0.01
                                      ? `A Receber / Crédito ${formatCurrency(sum.netBalance)}`
                                      : sum.netBalance < -0.01
                                      ? `Falta Pagar / Enviar ${formatCurrency(
                                          Math.abs(sum.netBalance)
                                        )}`
                                      : 'Quitado no Mês (R$ 0,00)'}
                                  </span>
                                </div>
                              </div>

                              {/* Barra de Progresso de Cobertura Percentual */}
                              <div className="space-y-1">
                                <div className="w-full h-2 rounded-full bg-slate-900 overflow-hidden">
                                  <div
                                    className={`h-full rounded-full transition-all ${
                                      sum.coveragePercent >= sum.responsibilityPercent
                                        ? 'bg-emerald-500'
                                        : 'bg-indigo-500'
                                    }`}
                                    style={{
                                      width: `${Math.min(
                                        100,
                                        Math.max(0, sum.coveragePercent)
                                      )}%`,
                                    }}
                                  />
                                </div>
                              </div>

                              {/* Detalhamento de Cota vs. Aportes de Receita + Pagamentos Diretos */}
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-slate-700/60 font-mono text-[11px]">
                                <div>
                                  <span className="text-slate-400 block">
                                    Cota no Mês ({sum.responsibilityPercent.toFixed(0)}%)
                                  </span>
                                  <span className="text-slate-200 font-semibold">
                                    {formatCurrency(sum.totalResponsibility)}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-slate-400 block">
                                    Receitas Enviadas
                                  </span>
                                  <span className="text-emerald-300 font-semibold">
                                    +{formatCurrency(sum.incomeContributed)}
                                  </span>
                                  {sum.pendingIncomeContributed > 0 && (
                                    <span className="text-[10px] text-amber-300 block">
                                      Agend.: +{formatCurrency(sum.pendingIncomeContributed)}
                                    </span>
                                  )}
                                </div>
                                <div>
                                  <span className="text-slate-400 block">
                                    Despesas Pagas Direto
                                  </span>
                                  <span className="text-indigo-300 font-semibold">
                                    {formatCurrency(sum.directExpensePaid)}
                                  </span>
                                </div>
                                <div className="sm:text-right">
                                  <span className="text-slate-400 block">
                                    Total Acumulado Pago
                                  </span>
                                  <span className="text-white font-bold">
                                    {formatCurrency(sum.totalPaid)}
                                  </span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* 2. Receitas / Aportes Enviados ao Espaço no Mês */}
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <div>
                          <h4 className="text-xs font-bold text-slate-200">
                            2. Receitas / Aportes Enviados ao Espaço ({incomeTxs.length})
                          </h4>
                          <p className="text-[11px] text-slate-400">
                            Qualquer membro pode agendar ou enviar receita; quem recebe confirma a efetivação para entrar no caixa e abater a dívida de quem enviou.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            onOpenNewTransactionInSpace(
                              activeLedgerSpace.id,
                              'income'
                            )
                          }
                          className="px-3 py-1.5 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-300 text-xs font-semibold shrink-0 cursor-pointer"
                        >
                          + Enviar Receita
                        </button>
                      </div>

                      {incomeTxs.length === 0 ? (
                        <div className="p-4 rounded-2xl bg-slate-800/50 border border-slate-700/60 text-xs text-slate-400">
                          Nenhuma receita/aporte enviado ao espaço em{' '}
                          {formatMonthLabel(selectedMonth)}. Use "+ Enviar Receita" para transferir valores para o caixa do espaço.
                        </div>
                      ) : (
                        <div className="space-y-2.5">
                          {incomeTxs.map((tx) => {
                            const senderPart = activeLedgerSpace.participants.find(
                              (p) =>
                                p.email.toLowerCase() ===
                                tx.paidByEmail.toLowerCase()
                            );
                            const recipientPart =
                              activeLedgerSpace.participants.find(
                                (p) =>
                                  p.email.toLowerCase() ===
                                  (tx.recipientEmail || '').toLowerCase()
                              );
                            const isConfirmed = tx.status === 'paid';

                            return (
                              <div
                                key={tx.id}
                                className="p-3.5 rounded-2xl bg-slate-800/90 border border-slate-700/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                              >
                                <div
                                  onClick={() => onSelectTransaction(tx)}
                                  className="min-w-0 flex-1 cursor-pointer group"
                                >
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 font-mono text-[10px] font-bold">
                                      RECEITA / APORTE
                                    </span>
                                    <span className="font-bold text-white group-hover:text-emerald-300">
                                      {tx.description}
                                    </span>
                                  </div>
                                  <div className="text-[11px] text-slate-400 mt-1">
                                    Enviado por:{' '}
                                    <strong className="text-slate-200">
                                      {senderPart?.name || tx.paidByEmail}
                                    </strong>
                                    {tx.recipientEmail && (
                                      <>
                                        {' '}
                                        → Recebido por:{' '}
                                        <strong className="text-slate-200">
                                          {recipientPart?.name || tx.recipientEmail}
                                        </strong>
                                      </>
                                    )}{' '}
                                    · Data: {tx.dueDate}
                                  </div>
                                </div>

                                <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
                                  <div className="text-right font-mono tabular-nums">
                                    <div className="text-sm font-bold text-emerald-400">
                                      +{formatCurrency(tx.amount)}
                                    </div>
                                    <div
                                      className={`text-[10px] ${
                                        isConfirmed
                                          ? 'text-emerald-300'
                                          : 'text-amber-300'
                                      }`}
                                    >
                                      {isConfirmed
                                        ? 'Efetivado no Caixa'
                                        : 'Agendado / Aguardando'}
                                    </div>
                                  </div>

                                  {!isConfirmed && (
                                    <button
                                      type="button"
                                      onClick={() => onConfirmSpaceIncome(tx)}
                                      className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shadow-md shadow-emerald-600/20"
                                    >
                                      <i className="ph-bold ph-check-circle"></i>
                                      <span>Efetivar Receita</span>
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* 3. Despesas do Mês no Espaço (Com Baixa pelo Caixa ou Reembolso Direto) */}
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <div>
                          <h4 className="text-xs font-bold text-slate-200">
                            3. Despesas do Mês em {formatMonthLabel(selectedMonth)} ({expenseTxs.length})
                          </h4>
                          <p className="text-[11px] text-slate-400">
                            Despesas entram negativamente. Dê baixa usando o Caixa do Espaço (receitas recebidas) ou registre pagamento direto de um membro.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            onOpenNewTransactionInSpace(
                              activeLedgerSpace.id,
                              'expense'
                            )
                          }
                          className="px-3 py-1.5 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/30 text-rose-300 text-xs font-semibold shrink-0 cursor-pointer"
                        >
                          + Despesa
                        </button>
                      </div>

                      {expenseTxs.length === 0 ? (
                        <div className="p-5 rounded-2xl bg-slate-800/50 border border-slate-700/60 text-center text-xs text-slate-400">
                          Nenhuma despesa lançada neste espaço em{' '}
                          {formatMonthLabel(selectedMonth)}.
                        </div>
                      ) : (
                        <div className="space-y-2.5">
                          {expenseTxs.map((tx) => {
                            const isPaid = tx.status === 'paid';
                            const isOverdue = !isPaid && tx.status === 'overdue';
                            const isPaidBySpaceCash =
                              isPaid && tx.paidByEmail === 'space_cash';
                            const payerPart = activeLedgerSpace.participants.find(
                              (p) =>
                                p.email.toLowerCase() ===
                                tx.paidByEmail.toLowerCase()
                            );

                            return (
                              <div
                                key={tx.id}
                                className="p-3.5 rounded-2xl bg-slate-800/80 border border-slate-700/70 space-y-2.5 text-xs"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <button
                                    type="button"
                                    onClick={() => onSelectTransaction(tx)}
                                    className="min-w-0 flex-1 text-left cursor-pointer group"
                                  >
                                    <div className="font-semibold text-white group-hover:text-indigo-300 break-words flex items-center gap-1.5">
                                      <span>{tx.description}</span>
                                      <i className="ph-bold ph-caret-right text-xs text-slate-500 group-hover:text-indigo-400 shrink-0"></i>
                                    </div>
                                    <div className="text-slate-400 text-[11px] mt-0.5">
                                      Vencimento: {tx.dueDate} ·{' '}
                                      {isPaid ? (
                                        isPaidBySpaceCash ? (
                                          <span className="text-emerald-300 font-semibold">
                                            Paga pelo Caixa do Espaço
                                          </span>
                                        ) : (
                                          <span className="text-indigo-300 font-semibold">
                                            Paga direto por:{' '}
                                            {payerPart?.name || tx.paidByEmail}
                                          </span>
                                        )
                                      ) : isOverdue ? (
                                        <span className="text-rose-400 font-semibold">
                                          Em Atraso (Vencida) · Aguardando Pagamento
                                        </span>
                                      ) : (
                                        <span className="text-amber-300 font-semibold">
                                          No Prazo (A Pagar) · Aguardando Baixa
                                        </span>
                                      )}
                                    </div>
                                  </button>

                                  <div className="text-right font-mono tabular-nums shrink-0">
                                    <div className="font-bold text-rose-400 text-sm">
                                      -{formatCurrency(tx.amount)}
                                    </div>
                                    <div
                                      className={`text-[10px] ${
                                        isPaid
                                          ? 'text-emerald-400'
                                          : isOverdue
                                          ? 'text-rose-400 font-bold'
                                          : 'text-amber-300'
                                      }`}
                                    >
                                      {isPaid
                                        ? 'Paga'
                                        : isOverdue
                                        ? 'Vencida / Em Atraso'
                                        : 'No Prazo (A Pagar)'}
                                    </div>
                                  </div>
                                </div>

                                {/* Botões Rápidos de Dar Baixa para Despesas em Aberto */}
                                {!isPaid && (
                                  <div className="pt-2 border-t border-slate-700/60 flex flex-wrap items-center justify-between gap-2">
                                    <span className="text-[11px] text-slate-400">
                                      Dar baixa nesta despesa:
                                    </span>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          onSettleSpaceExpense(tx, 'space_cash')
                                        }
                                        className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold flex items-center gap-1.5 cursor-pointer"
                                      >
                                        <i className="ph-bold ph-vault"></i>
                                        <span>Dar Baixa pelo Caixa do Espaço</span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          onSettleSpaceExpense(
                                            tx,
                                            'member_direct',
                                            userEmail
                                          )
                                        }
                                        className="px-3 py-1.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-100 text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer"
                                      >
                                        <i className="ph-bold ph-user-check"></i>
                                        <span>Paguei do Meu Bolso</span>
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* 4. Acerto de Contas Complementar do Mês (Quem deve a quem após caixa e reembolsos) */}
                    <div>
                      <h4 className="text-xs font-bold text-slate-200 mb-3">
                        4. Acerto de Contas de {formatMonthLabel(selectedMonth)} (Diferenças Pendentes)
                      </h4>

                      {ledger.transfers.length === 0 ? (
                        <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2.5">
                          <i className="ph-fill ph-check-circle text-lg"></i>
                          <span>
                            Todas as cotas pagas de {formatMonthLabel(selectedMonth)} estão equilibradas entre os membros!
                          </span>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {ledger.transfers.map((tr, i) => (
                            <div
                              key={`${tr.fromEmail}_${tr.toEmail}_${i}`}
                              className="p-4 rounded-2xl bg-slate-800 border border-slate-700/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                            >
                              <div className="flex items-center gap-3">
                                <div className="w-9 h-9 rounded-xl bg-amber-500/15 text-amber-400 flex items-center justify-center shrink-0">
                                  <i className="ph-bold ph-arrows-left-right"></i>
                                </div>
                                <div className="text-xs">
                                  <span className="font-bold text-rose-300">
                                    {tr.fromName}
                                  </span>{' '}
                                  <span className="text-slate-400">
                                    pode transferir/reembolsar
                                  </span>{' '}
                                  <span className="font-bold text-emerald-300 font-mono">
                                    {formatCurrency(tr.amount)}
                                  </span>{' '}
                                  <span className="text-slate-400">para</span>{' '}
                                  <span className="font-bold text-emerald-300">
                                    {tr.toName}
                                  </span>
                                </div>
                              </div>

                              <button
                                type="button"
                                onClick={() =>
                                  onSettleTransfer(
                                    activeLedgerSpace,
                                    tr.fromEmail,
                                    tr.fromName,
                                    tr.toEmail,
                                    tr.toName,
                                    tr.amount
                                  )
                                }
                                className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                              >
                                <i className="ph-bold ph-check"></i>
                                <span>Liquidar Diferença</span>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Rodapé Fixo do Drawer */}
            <div className="p-4 sm:px-6 border-t border-slate-800 bg-slate-900 flex items-center justify-between gap-3 shrink-0">
              <button
                type="button"
                onClick={() => setDeletingSpace(activeLedgerSpace)}
                className="px-3.5 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 text-rose-400 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                <i className="ph-bold ph-trash" aria-hidden="true"></i>
                <span>Excluir Espaço</span>
              </button>

              <button
                type="button"
                onClick={() => onSetActiveLedgerSpace(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 cursor-pointer"
              >
                Fechar Gaveta de Auditoria
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Criar ou Editar Espaço Compartilhado */}
      {isSpaceModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={
            editingSpace
              ? `Editar Espaço ${editingSpace.name}`
              : 'Criar Novo Espaço Compartilhado'
          }
        >
          <div className="w-full max-w-md bg-slate-800 border border-slate-700 rounded-3xl p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-bold text-white">
                  {editingSpace
                    ? 'Editar Espaço Compartilhado'
                    : 'Novo Espaço Compartilhado'}
                </h3>
                <p className="text-xs text-slate-400">
                  {editingSpace
                    ? 'Atualize nome, descrição, aparência e participantes do espaço.'
                    : 'Configure um espaço para ratear despesas e auditar o Livro-Razão.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsSpaceModalOpen(false);
                  setEditingSpace(null);
                }}
                aria-label="Fechar modal"
                className="w-8 h-8 rounded-xl bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center cursor-pointer"
              >
                <i className="ph-bold ph-x" aria-hidden="true"></i>
              </button>
            </div>

            {formError && (
              <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
                {formError}
              </div>
            )}

            <form onSubmit={handleSpaceFormSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="sp-name"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  Nome do Espaço
                </label>
                <input
                  id="sp-name"
                  type="text"
                  value={spaceName}
                  onChange={(e) => setSpaceName(e.target.value)}
                  placeholder="Ex: Casa, Viagem Noronha, Churrasco..."
                  className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white"
                />
              </div>

              <div>
                <label
                  htmlFor="sp-desc"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  Descrição / Objetivo
                </label>
                <input
                  id="sp-desc"
                  type="text"
                  value={spaceDesc}
                  onChange={(e) => setSpaceDesc(e.target.value)}
                  placeholder="Despesas compartilhadas do grupo"
                  className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="sp-icon"
                    className="block text-xs font-medium text-slate-300 mb-1"
                  >
                    Ícone
                  </label>
                  <select
                    id="sp-icon"
                    value={spaceIcon}
                    onChange={(e) => setSpaceIcon(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white"
                  >
                    <option value="ph-house-line">Casa / Moradia</option>
                    <option value="ph-airplane-tilt">Viagem / Férias</option>
                    <option value="ph-mountains">Expedição / Lazer</option>
                    <option value="ph-users-three">Grupo / Família</option>
                    <option value="ph-cheers">Eventos / Festas</option>
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="sp-color"
                    className="block text-xs font-medium text-slate-300 mb-1"
                  >
                    Cor Tema
                  </label>
                  <select
                    id="sp-color"
                    value={spaceColor}
                    onChange={(e) => setSpaceColor(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white"
                  >
                    <option value="indigo">Índigo</option>
                    <option value="purple">Roxo</option>
                    <option value="emerald">Esmeralda</option>
                    <option value="amber">Âmbar</option>
                  </select>
                </div>
              </div>

              {editingSpace && editingParticipants.length > 0 && (
                <div>
                  <span className="block text-xs font-medium text-slate-300 mb-1.5">
                    Participantes Atuais ({editingParticipants.length})
                  </span>
                  <div className="space-y-1.5 max-h-36 overflow-y-auto p-2.5 rounded-xl bg-slate-900 border border-slate-700/80">
                    {editingParticipants.map((p) => {
                      const isMe =
                        p.email.toLowerCase() === userEmail.toLowerCase();
                      return (
                        <div
                          key={p.email}
                          className="flex items-center justify-between text-xs py-1 px-2 rounded-lg bg-slate-800/80"
                        >
                          <div className="truncate">
                            <span className="font-semibold text-white">
                              {p.name}
                            </span>{' '}
                            <span className="text-slate-400">({p.email})</span>
                          </div>
                          {!isMe && (
                            <button
                              type="button"
                              onClick={() =>
                                handleRemoveParticipantFromEdit(p.email)
                              }
                              aria-label={`Remover participante ${p.name}`}
                              className="text-rose-400 hover:text-rose-300 text-[11px] font-semibold ml-2 cursor-pointer"
                            >
                              Remover
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <label
                  htmlFor="sp-invites"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  {editingSpace
                    ? 'Adicionar Novos Participantes via E-mail (separados por vírgula)'
                    : 'Convidar Participantes via E-mail (separados por vírgula)'}
                </label>
                <input
                  id="sp-invites"
                  type="text"
                  value={inviteEmailsRaw}
                  onChange={(e) => setInviteEmailsRaw(e.target.value)}
                  placeholder="marina@email.com, joao@email.com"
                  className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white"
                />
              </div>

              <div className="pt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsSpaceModalOpen(false);
                    setEditingSpace(null);
                  }}
                  className="px-4 py-2 rounded-xl bg-slate-700 text-xs font-semibold text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white cursor-pointer"
                >
                  {submitting
                    ? 'Salvando...'
                    : editingSpace
                    ? 'Salvar Alterações'
                    : 'Criar Espaço & Enviar Convites'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal de Confirmação de Exclusão de Espaço */}
      {deletingSpace && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Confirmar exclusão de espaço compartilhado"
        >
          <div className="w-full max-w-md bg-slate-800 border border-slate-700 rounded-3xl p-6 shadow-2xl">
            <div className="flex items-center gap-3.5 mb-4">
              <div className="w-11 h-11 rounded-2xl bg-rose-500/15 border border-rose-500/30 text-rose-400 flex items-center justify-center shrink-0">
                <i className="ph-fill ph-warning-octagon text-2xl" aria-hidden="true"></i>
              </div>
              <div>
                <h3 className="text-base font-bold text-white">
                  Excluir Espaço "{deletingSpace.name}"?
                </h3>
                <p className="text-xs text-slate-400">
                  Esta ação removerá o espaço compartilhado permanentemente.
                </p>
              </div>
            </div>

            {(() => {
              const linkedCount = transactions.filter(
                (tx) => tx.spaceId === deletingSpace.id
              ).length;
              return (
                <div className="p-3.5 rounded-2xl bg-slate-900 border border-slate-700/80 text-xs text-slate-300 mb-5">
                  {linkedCount > 0 ? (
                    <span>
                      Existem <strong className="text-white">{linkedCount}</strong>{' '}
                      lançamento(s) histórico(s) vinculados a este espaço. Eles continuarão salvos no seu extrato.
                    </span>
                  ) : (
                    <span>
                      Não há lançamentos vinculados a este espaço no momento.
                    </span>
                  )}
                </div>
              );
            })()}

            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setDeletingSpace(null)}
                className="px-4 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-200 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={handleConfirmDeleteSpace}
                className="px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-xs font-semibold text-white shadow-lg shadow-rose-600/25 flex items-center gap-1.5 cursor-pointer"
              >
                <i className="ph-bold ph-trash" aria-hidden="true"></i>
                <span>
                  {submitting ? 'Excluindo...' : 'Sim, Excluir Espaço'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Convite Individual por E-mail */}
      {inviteModalSpace && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Convidar participante por e-mail"
        >
          <div className="w-full max-w-md bg-slate-800 border border-slate-700 rounded-3xl p-6 shadow-2xl">
            <h3 className="text-base font-bold text-white mb-1">
              Convidar para {inviteModalSpace.name}
            </h3>
            <p className="text-xs text-slate-400 mb-4">
              O participante receberá um aviso transacional via EmailJS e terá acesso imediato aos rateios pelo e-mail.
            </p>
            <form onSubmit={handleSingleInviteSubmit} className="space-y-3">
              <input
                type="text"
                value={singleInviteName}
                onChange={(e) => setSingleInviteName(e.target.value)}
                placeholder="Nome do convidado"
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white"
              />
              <input
                type="email"
                required
                value={singleInviteEmail}
                onChange={(e) => setSingleInviteEmail(e.target.value)}
                placeholder="email.convidado@exemplo.com"
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white"
              />
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setInviteModalSpace(null)}
                  className="px-4 py-2 rounded-xl bg-slate-700 text-xs font-semibold text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white cursor-pointer"
                >
                  Enviar Convite
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Configuração e Log EmailJS */}
      {showEmailJsModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Configuração e Histórico EmailJS"
        >
          <div className="w-full max-w-lg bg-slate-800 border border-slate-700 rounded-3xl p-6 shadow-2xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-white">
                Integração EmailJS & Histórico de Disparos
              </h3>
              <button
                type="button"
                onClick={() => setShowEmailJsModal(false)}
                aria-label="Fechar modal EmailJS"
                className="w-8 h-8 rounded-xl bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center cursor-pointer"
              >
                <i className="ph-bold ph-x" aria-hidden="true"></i>
              </button>
            </div>

            <div className="space-y-3 mb-6 p-4 rounded-2xl bg-slate-900 border border-slate-700">
              <div className="text-xs font-semibold text-slate-200">
                Credenciais EmailJS (Opcional para disparo SMTP externo)
              </div>
              <input
                type="text"
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
                placeholder="Service ID (ex: service_xxx)"
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
              />
              <input
                type="text"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                placeholder="Template ID (ex: template_xxx)"
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
              />
              <input
                type="text"
                value={publicKey}
                onChange={(e) => setPublicKey(e.target.value)}
                placeholder="Public Key"
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white"
              />
              <button
                type="button"
                onClick={() => {
                  saveEmailJSConfig({ serviceId, templateId, publicKey });
                  onNotifyToast('Configuração EmailJS salva com sucesso.');
                }}
                className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold cursor-pointer"
              >
                Salvar Configuração EmailJS
              </button>
            </div>

            <div>
              <h4 className="text-xs font-bold text-slate-300 mb-2">
                Últimos E-mails Transacionais Enviados ({sentLogs.length})
              </h4>
              {sentLogs.length === 0 ? (
                <p className="text-xs text-slate-400">
                  Nenhum convite ou rateio disparado nesta sessão ainda.
                </p>
              ) : (
                <div className="space-y-2">
                  {sentLogs.map((log, index) => (
                    <div
                      key={index}
                      className="p-3 rounded-xl bg-slate-900/70 border border-slate-700/60 text-xs"
                    >
                      <div className="flex justify-between font-semibold text-white">
                        <span>Para: {log.toEmail}</span>
                        <span className="text-emerald-400 font-mono">
                          {log.amountFormatted || 'Convite'}
                        </span>
                      </div>
                      <div className="text-slate-300 mt-0.5">{log.subject}</div>
                      <div className="text-slate-400 text-[11px] mt-1">
                        {log.message}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
