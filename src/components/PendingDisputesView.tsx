import React, { useState } from 'react';
import { Space, Transaction } from '../types/finance';
import { formatCurrency } from '../utils/financeEngine';

interface PendingDisputesViewProps {
  spaces: Space[];
  transactions: Transaction[];
  userEmail: string;
  dismissedSpaceNotifIds: string[];
  onDismissSpaceNotif: (txId: string) => void;
  onClearAllSpaceNotifs: (txIds: string[]) => void;
  onAcceptSpaceInvite: (spaceId: string) => Promise<void>;
  onDeclineSpaceInvite: (spaceId: string) => Promise<void>;
  onAcceptSplit: (tx: Transaction) => Promise<void>;
  onRejectSplit: (tx: Transaction, reason: string) => Promise<void>;
  onProposeNewValue: (
    tx: Transaction,
    proposedAmount: number,
    reason: string
  ) => Promise<void>;
}

export const PendingDisputesView: React.FC<PendingDisputesViewProps> = ({
  spaces,
  transactions,
  userEmail,
  dismissedSpaceNotifIds,
  onDismissSpaceNotif,
  onClearAllSpaceNotifs,
  onAcceptSpaceInvite,
  onDeclineSpaceInvite,
  onAcceptSplit,
  onRejectSplit,
  onProposeNewValue,
}) => {
  const [negotiatingTx, setNegotiatingTx] = useState<Transaction | null>(null);
  const [negotiationMode, setNegotiationMode] = useState<'propose' | 'reject'>(
    'propose'
  );
  const [proposedVal, setProposedVal] = useState('');
  const [disputeNote, setDisputeNote] = useState('');

  // 1. Convites para Novos Espaços / Grupos onde o usuário atual está com status 'invited' (Pendente)
  const pendingSpaceInvites = spaces.filter((sp) =>
    sp.participants.some(
      (p) =>
        p.email.toLowerCase() === userEmail.toLowerCase() &&
        p.status === 'invited'
    )
  );

  // 2. Despesas Avulsas (Fora de Espaço: !tx.spaceId) que aguardam aceite, cotação ou contraproposta
  const adhocInboxItems = transactions.filter((tx) => {
    const isSpaceTx = Boolean(tx.spaceId && tx.spaceId.trim().length > 0);
    if (isSpaceTx) return false; // Despesas de grupo não exigem aceite no Inbox

    if (tx.status === 'validating') return true;
    if (tx.splits && tx.splits.length > 0) {
      const myShare = tx.splits.find(
        (s) => s.email.toLowerCase() === userEmail.toLowerCase()
      );
      if (
        myShare &&
        (myShare.status === 'pending' || myShare.status === 'disputed')
      ) {
        return true;
      }
    }
    return false;
  });

  // 3. Avisos Informativos de Lançamentos criados em Espaços Compartilhados (podem ser apagados, sem exigir aceite)
  const spaceActivityNotifications = transactions
    .filter((tx) => {
      const isSpaceTx = Boolean(tx.spaceId && tx.spaceId.trim().length > 0);
      if (!isSpaceTx) return false;
      return !dismissedSpaceNotifIds.includes(tx.id);
    })
    .sort((a, b) => b.competenceDate.localeCompare(a.competenceDate));

  // Histórico de Rateios Avulsos já validados/resolvidos
  const resolvedAdhocItems = transactions.filter((tx) => {
    const isSpaceTx = Boolean(tx.spaceId && tx.spaceId.trim().length > 0);
    if (isSpaceTx) return false;
    if (!tx.splits || tx.splits.length <= 1) return false;
    return !adhocInboxItems.some((i) => i.id === tx.id);
  });

  const openNegotiationModal = (
    tx: Transaction,
    mode: 'propose' | 'reject'
  ) => {
    const myShare = tx.splits.find(
      (s) => s.email.toLowerCase() === userEmail.toLowerCase()
    );
    setNegotiatingTx(tx);
    setNegotiationMode(mode);
    setProposedVal(
      String(
        myShare?.proposedAmount || myShare?.responsibility || tx.amount / 2
      )
    );
    setDisputeNote(tx.disputeReason || '');
  };

  const handleConfirmNegotiation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!negotiatingTx) return;

    if (negotiationMode === 'reject') {
      await onRejectSplit(
        negotiatingTx,
        disputeNote.trim() || 'Rateio avulso recusado pelo participante.'
      );
    } else {
      await onProposeNewValue(
        negotiatingTx,
        Math.max(0, Number(proposedVal) || 0),
        disputeNote.trim() || 'Contraproposta de valor enviada para revisão.'
      );
    }

    setNegotiatingTx(null);
    setDisputeNote('');
  };

  return (
    <div className="space-y-8">
      {/* Cabeçalho */}
      <div>
        <h2 className="text-xl font-bold text-white">
          Central de Notificações, Convites & Rateios Avulsos (Inbox)
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Aceite convites para entrar em novos espaços, valide rateios avulsos (fora de grupo) e acompanhe avisos informativos de lançamentos nos seus grupos.
        </p>
      </div>

      {/* 1. Convites para Entrar em Novos Espaços / Grupos */}
      <div>
        <h3 className="text-sm font-bold text-indigo-300 mb-3 flex items-center gap-2">
          <i className="ph-fill ph-users-three text-lg text-indigo-400"></i>
          <span>
            1. Convites para Novos Espaços / Grupos ({pendingSpaceInvites.length})
          </span>
        </h3>

        {pendingSpaceInvites.length === 0 ? (
          <div className="bg-slate-800/60 border border-slate-700/70 rounded-2xl p-4 text-xs text-slate-400 flex items-center gap-2.5">
            <i className="ph-fill ph-check-circle text-emerald-400 text-base"></i>
            <span>
              Nenhum convite pendente para novos grupos no momento.
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {pendingSpaceInvites.map((sp) => (
              <div
                key={sp.id}
                className="bg-slate-800 border border-indigo-500/40 rounded-3xl p-5 flex flex-col justify-between gap-4"
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 flex items-center justify-center shrink-0">
                        <i
                          className={`ph-fill ${
                            sp.icon || 'ph-users-three'
                          } text-2xl`}
                        ></i>
                      </div>
                      <div>
                        <span className="px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] font-bold uppercase tracking-wider">
                          Convite Pendente de Aceite
                        </span>
                        <h4 className="text-base font-bold text-white mt-1">
                          {sp.name}
                        </h4>
                        <p className="text-xs text-slate-400">
                          {sp.description}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 p-3 rounded-2xl bg-slate-900/80 border border-slate-700/70 text-xs text-slate-300 space-y-1">
                    <div>
                      Criado por:{' '}
                      <strong className="text-white font-mono">
                        {sp.ownerEmail}
                      </strong>
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Enquanto você não aceitar, seu status neste grupo permanece como{' '}
                      <strong className="text-amber-300">Pendente</strong>.
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-700/60">
                  <button
                    type="button"
                    onClick={() => onAcceptSpaceInvite(sp.id)}
                    className="flex-1 py-2.5 px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <i className="ph-bold ph-check-circle"></i>
                    <span>Aceitar Entrada no Grupo</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeclineSpaceInvite(sp.id)}
                    className="py-2.5 px-3.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <i className="ph-bold ph-x-circle"></i>
                    <span>Recusar</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 2. Despesas Avulsas (Fora de Espaço) Aguardando Aceite / Cotação */}
      <div>
        <div className="mb-3">
          <h3 className="text-sm font-bold text-amber-400 flex items-center gap-2">
            <i className="ph-fill ph-scales text-lg"></i>
            <span>
              2. Despesas Avulsas (Fora de Grupo) Aguardando Seu Aceite / Cotação ({adhocInboxItems.length})
            </span>
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Exclusivo para rateios avulsos lançados sem vínculo a um grupo. Ao aceitar, você confirma sua cota-parte (a despesa continua controlada pela data de vencimento até ser paga).
          </p>
        </div>

        {adhocInboxItems.length === 0 ? (
          <div className="bg-slate-800 border border-slate-700/80 rounded-3xl p-8 text-center">
            <div className="w-11 h-11 rounded-2xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center mx-auto mb-2.5">
              <i className="ph-fill ph-check-circle text-2xl"></i>
            </div>
            <h4 className="text-sm font-bold text-white">
              Nenhum rateio avulso pendente de aprovação!
            </h4>
            <p className="text-xs text-slate-400 mt-1">
              Despesas lançadas dentro dos seus Espaços Compartilhados entram direto no Livro-Razão do mês sem exigir aceite individual.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {adhocInboxItems.map((tx) => {
              const myShare = tx.splits.find(
                (s) => s.email.toLowerCase() === userEmail.toLowerCase()
              );

              return (
                <div
                  key={tx.id}
                  className="bg-slate-800 border border-amber-500/40 rounded-3xl p-5 sm:p-6 flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-start justify-between gap-3 mb-4">
                      <div>
                        <span className="px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-[10px] font-bold uppercase tracking-wider text-amber-300">
                          Rateio Avulso (Sem Grupo)
                        </span>
                        <h4 className="text-base sm:text-lg font-bold text-white mt-1">
                          {tx.description}
                        </h4>
                        <p className="text-xs text-slate-400 mt-0.5">
                          Lançado por{' '}
                          <strong className="text-slate-200">
                            {tx.ownerName}
                          </strong>{' '}
                          ({tx.paidByEmail}) · Vencimento: {tx.dueDate}
                        </p>
                      </div>

                      <div className="text-right shrink-0">
                        <span className="text-[11px] text-slate-400 block">
                          Valor Total da Despesa
                        </span>
                        <span className="text-base font-bold text-slate-200 font-mono tabular-nums">
                          {formatCurrency(tx.amount)}
                        </span>
                      </div>
                    </div>

                    {/* Destaque da Cota atribuída ao usuário */}
                    <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-700/70 mb-4 flex items-center justify-between">
                      <div>
                        <span className="text-xs text-slate-400 block">
                          Sua Cota-Parte Solicitada
                        </span>
                        <span className="text-xl font-bold text-amber-400 font-mono tabular-nums">
                          {formatCurrency(myShare?.responsibility || 0)}
                        </span>
                      </div>

                      {tx.proposedAmount > 0 && (
                        <div className="text-right">
                          <span className="text-xs text-indigo-300 block">
                            Cotação / Valor Proposto
                          </span>
                          <span className="text-base font-bold text-indigo-400 font-mono tabular-nums">
                            {formatCurrency(tx.proposedAmount)}
                          </span>
                        </div>
                      )}
                    </div>

                    {(tx.disputeReason || myShare?.note) && (
                      <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-200 mb-5">
                        <strong className="block mb-0.5">
                          Observação / Detalhe da Cotação:
                        </strong>
                        <span>{tx.disputeReason || myShare?.note}</span>
                      </div>
                    )}
                  </div>

                  {/* Ações de Negociação: Aceitar, Propor Novo Valor / Cotação, Recusar */}
                  <div className="pt-4 border-t border-slate-700/60 flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onAcceptSplit(tx)}
                      className="flex-1 py-2.5 px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <i className="ph-bold ph-check-circle"></i>
                      <span>Aceitar Cota</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => openNegotiationModal(tx, 'propose')}
                      className="flex-1 py-2.5 px-3.5 rounded-xl bg-indigo-600/25 hover:bg-indigo-600/40 border border-indigo-500/40 text-indigo-200 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <i className="ph-bold ph-scales"></i>
                      <span>Contestar / Propor Valor</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => openNegotiationModal(tx, 'reject')}
                      className="py-2.5 px-3.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <i className="ph-bold ph-x-circle"></i>
                      <span>Recusar</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 3. Avisos Informativos de Lançamentos nos Espaços Compartilhados (Dispensáveis / Podem ser Apagados) */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <i className="ph-fill ph-bell-ringing text-indigo-400 text-lg"></i>
              <span>
                3. Avisos de Movimentações nos Espaços ({spaceActivityNotifications.length})
              </span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Apenas informativo de que uma despesa ou receita foi inserida em um grupo (não exige aceite e você pode apagar os avisos).
            </p>
          </div>

          {spaceActivityNotifications.length > 0 && (
            <button
              type="button"
              onClick={() =>
                onClearAllSpaceNotifs(
                  spaceActivityNotifications.map((t) => t.id)
                )
              }
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <i className="ph-bold ph-trash"></i>
              <span>Apagar Todos os Avisos ({spaceActivityNotifications.length})</span>
            </button>
          )}
        </div>

        {spaceActivityNotifications.length === 0 ? (
          <div className="bg-slate-800/50 border border-slate-700/60 rounded-2xl p-5 text-xs text-slate-400 text-center">
            Nenhum aviso pendente de leitura nos seus espaços compartilhados.
          </div>
        ) : (
          <div className="space-y-2.5">
            {spaceActivityNotifications.map((tx) => {
              const myShare = tx.splits?.find(
                (s) => s.email.toLowerCase() === userEmail.toLowerCase()
              );
              return (
                <div
                  key={tx.id}
                  className="p-4 rounded-2xl bg-slate-800/90 border border-slate-700/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                        tx.type === 'income'
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : 'bg-indigo-500/15 text-indigo-400'
                      }`}
                    >
                      <i
                        className={`ph-fill ${
                          tx.type === 'income' ? 'ph-hand-coins' : 'ph-receipt'
                        } text-lg`}
                      ></i>
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="px-2 py-0.5 rounded-md bg-slate-900 border border-slate-700 text-indigo-300 font-semibold text-[10px]">
                          Espaço: {tx.spaceName}
                        </span>
                        <span className="font-bold text-white text-sm">
                          {tx.description}
                        </span>
                      </div>
                      <p className="text-slate-400 text-[11px] mt-0.5">
                        {tx.type === 'income'
                          ? `Receita/aporte registrado por ${tx.ownerName} em ${tx.competenceDate}`
                          : `Despesa inserida no grupo por ${tx.ownerName} · Vencimento: ${tx.dueDate}${
                              myShare
                                ? ` · Sua cota no mês: ${formatCurrency(
                                    myShare.responsibility
                                  )}`
                                : ''
                            }`}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
                    <span
                      className={`font-mono font-bold text-sm ${
                        tx.type === 'income'
                          ? 'text-emerald-400'
                          : 'text-rose-400'
                      }`}
                    >
                      {tx.type === 'income' ? '+' : '-'}
                      {formatCurrency(tx.amount)}
                    </span>

                    <button
                      type="button"
                      onClick={() => onDismissSpaceNotif(tx.id)}
                      aria-label={`Apagar aviso de ${tx.description}`}
                      title="Apagar esta notificação"
                      className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-rose-500/20 border border-slate-700 hover:border-rose-500/30 text-slate-300 hover:text-rose-300 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
                    >
                      <i className="ph-bold ph-trash"></i>
                      <span>Apagar Aviso</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Histórico de Rateios Avulsos Validados / Resolvidos */}
      {resolvedAdhocItems.length > 0 && (
        <div>
          <h3 className="text-sm font-bold text-slate-300 mb-3">
            Histórico de Rateios Avulsos Auditados ({resolvedAdhocItems.length})
          </h3>
          <div className="bg-slate-800 border border-slate-700/80 rounded-3xl overflow-hidden">
            <div className="divide-y divide-slate-700/50">
              {resolvedAdhocItems.map((tx) => {
                const myShare = tx.splits.find(
                  (s) => s.email.toLowerCase() === userEmail.toLowerCase()
                );
                return (
                  <div
                    key={tx.id}
                    className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                  >
                    <div>
                      <div className="font-bold text-white text-sm">
                        {tx.description}
                      </div>
                      <div className="text-slate-400 mt-0.5">
                        Rateio Avulso · Lançado por {tx.ownerName} · Venc:{' '}
                        {tx.dueDate}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 font-mono tabular-nums">
                      <div className="text-right">
                        <span className="text-slate-400 block text-[11px]">
                          Sua Cota Confirmada
                        </span>
                        <span className="font-bold text-slate-100">
                          {formatCurrency(myShare?.responsibility || 0)}
                        </span>
                      </div>
                      <span
                        className={`font-semibold ${
                          tx.status === 'rejected'
                            ? 'text-rose-400'
                            : 'text-emerald-400'
                        }`}
                      >
                        {tx.status === 'rejected'
                          ? 'Recusado'
                          : 'Cota Aceita'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Modal de Contraproposta / Contestação / Recusa de Rateio Avulso */}
      {negotiatingTx && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Negociar ou Contestar Rateio Avulso"
        >
          <div className="w-full max-w-md bg-slate-800 border border-slate-700 rounded-3xl p-6 shadow-2xl">
            <h3 className="text-base font-bold text-white mb-1">
              {negotiationMode === 'propose'
                ? `Propor Novo Valor: ${negotiatingTx.description}`
                : `Recusar Rateio Avulso: ${negotiatingTx.description}`}
            </h3>
            <p className="text-xs text-slate-400 mb-4">
              {negotiationMode === 'propose'
                ? 'Informe o valor justo da sua cota-parte e a justificativa.'
                : 'Informe o motivo da recusa deste rateio avulso.'}
            </p>

            <form onSubmit={handleConfirmNegotiation} className="space-y-4">
              {negotiationMode === 'propose' && (
                <div>
                  <label
                    htmlFor="prop-val"
                    className="block text-xs font-medium text-slate-300 mb-1"
                  >
                    Novo Valor Proposto para Sua Cota (R$)
                  </label>
                  <input
                    id="prop-val"
                    type="number"
                    step="0.01"
                    value={proposedVal}
                    onChange={(e) => setProposedVal(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white font-mono"
                  />
                </div>
              )}

              <div>
                <label
                  htmlFor="prop-reason"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  Justificativa / Mensagem de Cotação
                </label>
                <textarea
                  id="prop-reason"
                  rows={3}
                  value={disputeNote}
                  onChange={(e) => setDisputeNote(e.target.value)}
                  placeholder="Ex: Minha parte foi apenas o prato principal..."
                  className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setNegotiatingTx(null)}
                  className="px-4 py-2 rounded-xl bg-slate-700 text-xs font-semibold text-slate-200 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className={`px-4 py-2 rounded-xl text-xs font-semibold text-white cursor-pointer ${
                    negotiationMode === 'propose'
                      ? 'bg-indigo-600 hover:bg-indigo-500'
                      : 'bg-rose-600 hover:bg-rose-500'
                  }`}
                >
                  {negotiationMode === 'propose'
                    ? 'Aplicar Contraproposta'
                    : 'Confirmar Recusa'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
