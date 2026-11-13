import React, { useEffect, useRef, useState } from 'react';
import {
  AuthorDataDestinationDecision,
  Space,
  SpaceAuditEvent,
  SpaceInvite,
  SpaceMember,
  SpaceMemberRole,
  SpaceModuleType,
  SpaceNotification,
} from '../../types/financeV3';
import {
  archiveSpace,
  createSpace,
  getSpaceById,
  getSpaceMembers,
  getUserSpaces,
  leaveSpace,
  removeMemberFromSpace,
  SpaceViewMode,
  subscribeToUserActiveSpaces,
  unarchiveSpace,
  updateMemberRole,
} from '../../services/spaceService';
import {
  acceptSpaceInvite,
  createSpaceInvite,
  DEFAULT_INVITE_EXPIRATION_DAYS,
  getInviteByRawToken,
  getSpaceInvites,
  revokeSpaceInvite,
} from '../../services/spaceInviteService';
import {
  cancelDissolutionByCreator,
  checkAndCancelExpiredDissolution,
  getSpaceDissolutionRequest,
  initiateSpaceDissolution,
  processDissolutionTimeout,
  submitAuthorDestinationDecision,
} from '../../services/spaceDissolutionService';
import { getSpaceAuditEvents } from '../../services/spaceAuditService';
import {
  getUserSpaceNotifications,
  markNotificationAsRead,
} from '../../services/spaceNotificationService';
import { SharedFinanceSectionV3 } from './SharedFinanceSectionV3';
import { UniversalTransactionPreset } from '../../types/finance';
import {
  createSpaceAttemptKey,
  executeSpaceCreationSubmission,
  mergeSpaceListItem,
} from '../../utils/spaceCreationFlow';

interface SharedSpacesViewV3Props {
  userId: string;
  userName: string;
  userEmail: string;
  isDemo?: boolean;
  openCreateTrigger?: number;
  refreshTrigger?: number;
  onConsumeCreateTrigger?: () => void;
  onSpacesChanged?: (space?: Space) => void;
  onOpenNewTransaction?: (preset?: UniversalTransactionPreset) => void;
  onOpenSpaceAcquisitions?: (spaceId: string) => void;
}

type SpaceTab =
  | 'members'
  | 'expenses'
  | 'liabilities'
  | 'validations'
  | 'refunds'
  | 'custody'
  | 'invites'
  | 'audit'
  | 'dissolution';

export const SharedSpacesViewV3: React.FC<SharedSpacesViewV3Props> = ({
  userId,
  userName,
  userEmail,
  isDemo = false,
  openCreateTrigger = 0,
  refreshTrigger = 0,
  onConsumeCreateTrigger,
  onSpacesChanged,
  onOpenNewTransaction,
  onOpenSpaceAcquisitions,
}) => {
  // Estados principais
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [selectedSpace, setSelectedSpace] = useState<Space | null>(null);
  const [selectedTab, setSelectedTab] = useState<SpaceTab>('members');
  const [loading, setLoading] = useState(true);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [spaceFilter, setSpaceFilter] = useState<SpaceViewMode>('active');
  const [notifications, setNotifications] = useState<SpaceNotification[]>([]);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Dados do espaço selecionado
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [invites, setInvites] = useState<SpaceInvite[]>([]);
  const [auditEvents, setAuditEvents] = useState<SpaceAuditEvent[]>([]);
  const [dissolutionReq, setDissolutionReq] = useState<any | null>(null);

  // Modais
  const [isCreateSpaceModalOpen, setIsCreateSpaceModalOpen] = useState(false);
  const [isCreatingSpace, setIsCreatingSpace] = useState(false);
  const [createAttemptKey, setCreateAttemptKey] = useState<string>(() =>
    createSpaceAttemptKey()
  );
  const createInFlightRef = useRef(false);
  const lastHandledCreateTriggerRef = useRef(0);
  const [newSpaceName, setNewSpaceName] = useState('');
  const [newSpaceDesc, setNewSpaceDesc] = useState('');
  const [newSpaceColor, setNewSpaceColor] = useState('#3b82f6');
  const [newSpaceIcon, setNewSpaceIcon] = useState('ph-users-three');
  const [newSpaceModules, setNewSpaceModules] = useState<SpaceModuleType[]>([
    'finance',
    'acquisitions',
  ]);
  const [newSpaceBudgetCents, setNewSpaceBudgetCents] = useState<number>(0);

  // Modal Convite
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<SpaceMemberRole>('member');
  const [inviteExpDays, setInviteExpDays] = useState(DEFAULT_INVITE_EXPIRATION_DAYS);
  const [generatedInviteResult, setGeneratedInviteResult] = useState<{
    invite: SpaceInvite;
    rawToken: string;
  } | null>(null);

  // Modal Aceitar Convite
  const [isAcceptModalOpen, setIsAcceptModalOpen] = useState(false);
  const [acceptTokenInput, setAcceptTokenInput] = useState('');
  const [invitePreview, setInvitePreview] = useState<SpaceInvite | null>(null);

  // Modal Decisão do Autor na Dissolução
  const [isDecisionModalOpen, setIsDecisionModalOpen] = useState(false);
  const [selectedDecision, setSelectedDecision] = useState<AuthorDataDestinationDecision>(
    'migrate_to_existing_personal_space'
  );
  const [targetSpaceIdInput, setTargetSpaceIdInput] = useState('');

  const openCreateSpaceModal = () => {
    setModalError(null);
    if (!isCreateSpaceModalOpen) {
      setCreateAttemptKey(createSpaceAttemptKey());
    }
    setIsCreateSpaceModalOpen(true);
  };

  const closeCreateSpaceModal = () => {
    if (createInFlightRef.current || isCreatingSpace) return;
    setModalError(null);
    setIsCreateSpaceModalOpen(false);
    setCreateAttemptKey(createSpaceAttemptKey());
  };

  // Carrega lista de espaços
  const loadSpaces = async (options?: { silent?: boolean }) => {
    try {
      if (!options?.silent) {
        setLoading(true);
      }
      const list = await getUserSpaces(userId, includeArchived, isDemo, spaceFilter);
      setSpaces(list);
      setSelectedSpace((prevSelected) => {
        if (!prevSelected) return null;
        const refreshed = list.find((s) => s.id === prevSelected.id);
        if (refreshed) return refreshed;
        if (!includeArchived && prevSelected.spaceStatus === 'archived') return null;
        return prevSelected;
      });
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message || 'Erro ao carregar espaços.' });
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  };

  // Carrega notificações
  const loadNotifications = async () => {
    try {
      const notifs = await getUserSpaceNotifications(userId, isDemo);
      setNotifications(notifs);
    } catch {
      // Ignora erro silenciosamente
    }
  };

  // Carrega sub-dados do espaço selecionado
  const loadSpaceDetails = async (space: Space) => {
    try {
      const isHistoricalOnly =
        !space.memberUids.includes(userId) && (space.historicalMemberUids?.includes(userId) ?? false);

      const [mems, invs, audits, diss] = await Promise.all([
        getSpaceMembers(space.id, userId, isDemo).catch(() => []),
        !isHistoricalOnly
          ? getSpaceInvites(space.id, userId, isDemo).catch(() => [])
          : Promise.resolve([]),
        getSpaceAuditEvents(space.id, userId, isDemo).catch(() => []),
        !isHistoricalOnly
          ? getSpaceDissolutionRequest(space.id, userId, isDemo).catch(() => null)
          : Promise.resolve(null),
      ]);
      setMembers(mems);
      setInvites(invs);
      setAuditEvents(audits);

      // Avalia se a solicitação expirou e processa timeout de forma estritamente idempotente
      if (diss && diss.requestStatus === 'pending_author_responses') {
        const checked = await processDissolutionTimeout(space.id, isDemo);
        setDissolutionReq(checked);
      } else {
        setDissolutionReq(diss);
      }
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message || 'Erro ao carregar detalhes do espaço.' });
    }
  };

  useEffect(() => {
    let active = true;
    loadSpaces();
    loadNotifications();

    if (isDemo || !userId || spaceFilter === 'historical') {
      return () => {
        active = false;
      };
    }

    const unsubscribe = subscribeToUserActiveSpaces(
      userId,
      includeArchived,
      (liveActiveSpaces) => {
        if (!active) return;
        if (spaceFilter === 'active') {
          setSpaces(liveActiveSpaces);
          setLoading(false);
          setSelectedSpace((prevSelected) => {
            if (!prevSelected) return null;
            const refreshed = liveActiveSpaces.find((s) => s.id === prevSelected.id);
            if (refreshed) return refreshed;
            if (!includeArchived && prevSelected.spaceStatus === 'archived') return null;
            return prevSelected;
          });
        } else {
          // Em modo 'all', sincroniza mantendo projeções históricas combinadas
          void loadSpaces({ silent: true });
        }
      },
      (err) => {
        if (!active) return;
        setFeedbackMessage({
          type: 'error',
          text: err.message || 'Erro ao sincronizar espaços em tempo real.',
        });
      },
      false
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, [userId, includeArchived, spaceFilter, isDemo, refreshTrigger]);

  useEffect(() => {
    if (openCreateTrigger > 0 && openCreateTrigger !== lastHandledCreateTriggerRef.current) {
      lastHandledCreateTriggerRef.current = openCreateTrigger;
      openCreateSpaceModal();
      onConsumeCreateTrigger?.();
    } else if (openCreateTrigger === 0) {
      lastHandledCreateTriggerRef.current = 0;
    }
  }, [openCreateTrigger, onConsumeCreateTrigger]);

  useEffect(() => {
    if (selectedSpace) {
      loadSpaceDetails(selectedSpace);
    }
  }, [selectedSpace]);

  // Handlers de Ações de Governança
  const handleCreateSpace = async (e: React.FormEvent) => {
    e.preventDefault();
    await executeSpaceCreationSubmission({
      inFlightRef: createInFlightRef,
      isSubmittingState: isCreatingSpace,
      attemptKey: createAttemptKey,
      form: {
        name: newSpaceName,
        description: newSpaceDesc,
        color: newSpaceColor,
        icon: newSpaceIcon,
        enabledModules: newSpaceModules,
        monthlyBudgetCents: newSpaceBudgetCents,
      },
      onStart: (resolvedKey) => {
        setCreateAttemptKey(resolvedKey);
        setIsCreatingSpace(true);
        setModalError(null);
        setFeedbackMessage(null);
      },
      submitFn: (resolvedKey) =>
        createSpace(
          userId,
          userName,
          userEmail,
          {
            name: newSpaceName.trim(),
            description: newSpaceDesc.trim(),
            icon: newSpaceIcon,
            color: newSpaceColor,
            enabledModules: newSpaceModules,
            monthlyBudgetCents: newSpaceBudgetCents > 0 ? newSpaceBudgetCents : undefined,
            idempotencyKey: resolvedKey,
          },
          isDemo
        ),
      onSuccess: async (res) => {
        setSelectedSpace(null);
        if (spaceFilter === 'historical') {
          setSpaceFilter('active');
        }
        setSpaces((prev) => mergeSpaceListItem(prev, res.space));
        setLoading(false);
        setIsCreateSpaceModalOpen(false);
        setModalError(null);
        setNewSpaceName('');
        setNewSpaceDesc('');
        setNewSpaceBudgetCents(0);
        setCreateAttemptKey(createSpaceAttemptKey());
        setFeedbackMessage({
          type: 'success',
          text: `Espaço "${res.space.name}" criado com sucesso!`,
        });
        onSpacesChanged?.(res.space);
        if (isDemo || spaceFilter === 'all') {
          await loadSpaces({ silent: true });
        }
      },
      onError: (friendlyMessage) => {
        // Mantém o modal aberto com todos os dados preenchidos e a mesma chave de idempotência
        setModalError(friendlyMessage);
      },
      onFinish: () => {
        setIsCreatingSpace(false);
      },
    });
  };

  const handleArchiveToggle = async () => {
    if (!selectedSpace) return;
    try {
      if (selectedSpace.spaceStatus === 'active') {
        const updated = await archiveSpace(selectedSpace.id, userId, userName, isDemo);
        setSelectedSpace(updated);
        setFeedbackMessage({ type: 'success', text: 'Espaço arquivado com sucesso. Agora está em modo somente leitura.' });
      } else if (selectedSpace.spaceStatus === 'archived') {
        const updated = await unarchiveSpace(selectedSpace.id, userId, userName, isDemo);
        setSelectedSpace(updated);
        setFeedbackMessage({ type: 'success', text: 'Espaço desarquivado com sucesso. Operações restauradas.' });
      }
      await loadSpaces();
      await loadSpaceDetails(selectedSpace);
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message });
    }
  };

  const handleRemoveMember = async (targetUid: string) => {
    if (!selectedSpace) return;
    if (!confirm('Deseja realmente remover este participante? Seus registros históricos continuarão preservados.')) {
      return;
    }
    try {
      await removeMemberFromSpace(selectedSpace.id, userId, userName, targetUid, isDemo);
      setFeedbackMessage({ type: 'success', text: 'Participante removido do espaço.' });
      const refreshed = await getSpaceById(selectedSpace.id, userId, isDemo);
      if (refreshed) setSelectedSpace(refreshed);
      await loadSpaceDetails(selectedSpace);
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message });
    }
  };

  const handleLeaveSpace = async () => {
    if (!selectedSpace) return;
    if (!confirm('Tem certeza de que deseja sair deste espaço? Você não terá mais acesso operacional.')) {
      return;
    }
    try {
      await leaveSpace(selectedSpace.id, userId, userName, isDemo);
      setFeedbackMessage({ type: 'success', text: 'Você saiu do espaço com sucesso.' });
      setSelectedSpace(null);
      await loadSpaces();
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message });
    }
  };

  const handleChangeRole = async (targetUid: string, newRole: SpaceMemberRole) => {
    if (!selectedSpace) return;
    try {
      await updateMemberRole(selectedSpace.id, userId, userName, targetUid, newRole, isDemo);
      setFeedbackMessage({ type: 'success', text: 'Papel do participante alterado com sucesso.' });
      await loadSpaceDetails(selectedSpace);
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message });
    }
  };

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSpace) return;

    try {
      const res = await createSpaceInvite(
        selectedSpace.id,
        userId,
        userName,
        {
          invitedEmail: inviteEmail || undefined,
          invitedRole: inviteRole,
          expirationDays: inviteExpDays,
        },
        isDemo
      );
      setGeneratedInviteResult(res);
      setFeedbackMessage({ type: 'success', text: 'Convite gerado com sucesso! Compartilhe o token seguro com o convidado.' });
      await loadSpaceDetails(selectedSpace);
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message });
    }
  };

  const handleRevokeInvite = async (tokenHash: string) => {
    if (!selectedSpace) return;
    try {
      await revokeSpaceInvite(tokenHash, userId, userName, isDemo);
      setFeedbackMessage({ type: 'success', text: 'Convite revogado com sucesso.' });
      await loadSpaceDetails(selectedSpace);
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message });
    }
  };

  const handleCheckTokenPreview = async () => {
    if (!acceptTokenInput.trim()) return;
    try {
      const inv = await getInviteByRawToken(acceptTokenInput.trim(), isDemo);
      if (!inv) {
        setFeedbackMessage({ type: 'error', text: 'Token inválido ou convite não localizado.' });
        setInvitePreview(null);
      } else {
        setInvitePreview(inv);
      }
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message });
    }
  };

  const handleAcceptInviteSubmit = async () => {
    if (!acceptTokenInput.trim()) return;
    try {
      const res = await acceptSpaceInvite(
        acceptTokenInput.trim(),
        { uid: userId, displayName: userName, email: userEmail },
        isDemo
      );
      setFeedbackMessage({ type: 'success', text: `Você ingressou no espaço "${res.space.name}"!` });
      setIsAcceptModalOpen(false);
      setAcceptTokenInput('');
      setInvitePreview(null);
      await loadSpaces();
      setSelectedSpace(res.space);
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message });
    }
  };

  const handleInitiateDissolution = async () => {
    if (!selectedSpace) return;
    if (
      !confirm(
        'ATENÇÃO: Você iniciará o processo formal de solicitação de dissolução definitiva. O espaço entrará em modo somente leitura e todos os autores terão 30 dias para manifestar a destinação de seus dados. Deseja prosseguir?'
      )
    ) {
      return;
    }
    try {
      const req = await initiateSpaceDissolution(selectedSpace.id, userId, userName, isDemo);
      setDissolutionReq(req);
      setFeedbackMessage({
        type: 'success',
        text: 'Solicitação de dissolução iniciada. Todos os membros foram notificados e o prazo de 30 dias foi aberto.',
      });
      await loadSpaces();
      await loadSpaceDetails(selectedSpace);
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message });
    }
  };

  const handleSubmitAuthorDecision = async () => {
    if (!selectedSpace) return;
    try {
      const updatedReq = await submitAuthorDestinationDecision(
        selectedSpace.id,
        userId,
        userName,
        selectedDecision,
        targetSpaceIdInput || undefined,
        isDemo
      );
      setDissolutionReq(updatedReq);
      setIsDecisionModalOpen(false);
      setFeedbackMessage({ type: 'success', text: 'Sua decisão sobre a destinação dos seus registros foi gravada com sucesso.' });
      await loadSpaceDetails(selectedSpace);
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message });
    }
  };

  const handleCancelDissolution = async () => {
    if (!selectedSpace) return;
    if (!confirm('Deseja cancelar a solicitação de dissolução? Os dados permanecerão integralmente preservados.')) {
      return;
    }
    try {
      const updatedReq = await cancelDissolutionByCreator(
        selectedSpace.id,
        userId,
        userName,
        'Cancelado pelo criador.',
        isDemo
      );
      setDissolutionReq(updatedReq);
      setFeedbackMessage({ type: 'success', text: 'Solicitação de dissolução cancelada.' });
      await loadSpaceDetails(selectedSpace);
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message });
    }
  };

  const isCreator = selectedSpace?.creatorUid === userId;
  const isArchived = selectedSpace?.spaceStatus === 'archived';
  const isActiveMember = selectedSpace ? selectedSpace.memberUids.includes(userId) : false;
  const isHistoricalOnly = selectedSpace
    ? !isActiveMember && (selectedSpace.historicalMemberUids?.includes(userId) ?? false)
    : false;
  const currentUserMember = members.find((m) => m.uid === userId);
  const isOwnerOrAdmin =
    isActiveMember &&
    (isCreator || currentUserMember?.role === 'owner' || currentUserMember?.role === 'admin');

  return (
    <div className="space-y-6">
      {/* Feedback Toast */}
      {feedbackMessage && (
        <div
          className={`p-4 rounded-xl flex items-center justify-between text-sm shadow-md transition-all ${
            feedbackMessage.type === 'success'
              ? 'bg-emerald-500/15 text-emerald-200 border border-emerald-500/30'
              : 'bg-rose-500/15 text-rose-200 border border-rose-500/30'
          }`}
        >
          <div className="flex items-center gap-2">
            <i
              className={`ph text-lg ${
                feedbackMessage.type === 'success' ? 'ph-check-circle text-emerald-400' : 'ph-warning-circle text-rose-400'
              }`}
            />
            <span>{feedbackMessage.text}</span>
          </div>
          <button
            onClick={() => setFeedbackMessage(null)}
            className="text-slate-400 hover:text-white cursor-pointer"
          >
            <i className="ph ph-x" />
          </button>
        </div>
      )}

      {/* Header com Visão Geral e Controles */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 flex items-center justify-center text-xl font-bold shrink-0">
                <i className="ph ph-users-three" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white">
                  Espaços Compartilhados (Arquitetura v3.1)
                </h1>
                <p className="text-xs text-slate-400">
                  Governança coletiva sem fundos ou caixas coletivos, com autoridade soberana, convites com hash SHA-256 e isolamento absoluto de dados pessoais.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => {
                setModalError(null);
                setIsAcceptModalOpen(true);
              }}
              className="px-4 py-2 border border-slate-700 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-700 hover:text-white bg-slate-800 flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <i className="ph ph-ticket text-base" />
              Aceitar Convite
            </button>

            <button
              onClick={() => setIsNotifOpen(true)}
              className="relative px-4 py-2 border border-slate-700 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-700 hover:text-white bg-slate-800 flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <i className="ph ph-bell text-base" />
              Notificações
              {notifications.filter((n) => !n.read).length > 0 && (
                <span className="absolute -top-1 -right-1 w-5 h-5 bg-rose-500 text-white rounded-full text-[10px] font-bold flex items-center justify-center">
                  {notifications.filter((n) => !n.read).length}
                </span>
              )}
            </button>

            <button
              onClick={openCreateSpaceModal}
              className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-500 flex items-center gap-1.5 transition-colors shadow-sm cursor-pointer"
            >
              <i className="ph ph-plus-circle text-base" />
              Novo Espaço
            </button>
          </div>
        </div>

        {/* Resumo de Indicadores */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6 pt-6 border-t border-slate-700/80">
          <div>
            <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
              Espaços Ativos
            </span>
            <p className="text-xl font-bold text-white mt-1">
              {spaces.filter((s) => s.spaceStatus === 'active').length}
            </p>
          </div>
          <div>
            <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
              Criados por Mim
            </span>
            <p className="text-xl font-bold text-indigo-400 mt-1">
              {spaces.filter((s) => s.creatorUid === userId).length}
            </p>
          </div>
          <div>
            <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
              Arquivados
            </span>
            <p className="text-xl font-bold text-slate-400 mt-1">
              {spaces.filter((s) => s.spaceStatus === 'archived').length}
            </p>
          </div>
          <div>
            <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
              Filtro de Arquivados
            </span>
            <div className="mt-1 flex items-center gap-2">
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeArchived}
                  onChange={(e) => setIncludeArchived(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-500 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600" />
              </label>
              <span className="text-xs text-slate-300">
                {includeArchived ? 'Exibindo' : 'Ocultos'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Conteúdo Principal: Lista ou Detalhes */}
      {!selectedSpace ? (
        /* LISTAGEM DE ESPAÇOS */
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-6 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">
              Meus Espaços Compartilhados ({spaces.length})
            </h2>

            <div className="flex items-center gap-1 bg-slate-900 border border-slate-700/80 p-1 rounded-xl text-xs font-semibold">
              <button
                type="button"
                onClick={() => setSpaceFilter('active')}
                className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                  spaceFilter === 'active'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                Ativos
              </button>
              <button
                type="button"
                onClick={() => setSpaceFilter('historical')}
                className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                  spaceFilter === 'historical'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                Histórico (Ex-Membro)
              </button>
              <button
                type="button"
                onClick={() => setSpaceFilter('all')}
                className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                  spaceFilter === 'all'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                Todos
              </button>
            </div>
          </div>

          {loading ? (
            <div className="py-12 text-center text-slate-400 text-sm">
              <i className="ph ph-spinner animate-spin text-2xl mb-2" />
              <p>Carregando espaços...</p>
            </div>
          ) : spaces.length === 0 ? (
            <div className="py-12 text-center border-2 border-dashed border-slate-700/80 rounded-xl bg-slate-800/40">
              <i className="ph ph-users-three text-3xl text-slate-500 mb-2" />
              <p className="text-sm font-medium text-slate-300">
                Nenhum espaço compartilhado encontrado.
              </p>
              <p className="text-xs text-slate-400 mt-1">
                Crie um novo espaço ou utilize um token de convite para ingressar.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {spaces.map((s) => {
                const isUserCreator = s.creatorUid === userId;
                const isUserHistorical =
                  !s.memberUids.includes(userId) && (s.historicalMemberUids?.includes(userId) ?? false);
                return (
                  <div
                    key={s.id}
                    onClick={() => setSelectedSpace(s)}
                    className="border border-slate-700 hover:border-indigo-400 rounded-xl p-5 cursor-pointer transition-all bg-slate-800/90 hover:shadow-md flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <div
                          className="w-10 h-10 rounded-xl flex items-center justify-center text-xl text-white"
                          style={{ backgroundColor: s.color || '#3b82f6' }}
                        >
                          <i className={`ph ${s.icon || 'ph-users-three'}`} />
                        </div>
                        <div className="flex items-center gap-1.5">
                          {s.spaceStatus === 'archived' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 flex items-center gap-1">
                              <i className="ph ph-lock-key" /> Arquivado
                            </span>
                          )}
                          {isUserHistorical ? (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-700/80 text-slate-200 border border-slate-600">
                              Histórico (Ex-Membro)
                            </span>
                          ) : isUserCreator ? (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                              Criador
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-700/80 text-slate-300 border border-slate-600">
                              Membro
                            </span>
                          )}
                        </div>
                      </div>

                      <h3 className="text-base font-bold text-white truncate">{s.name}</h3>
                      <p className="text-xs text-slate-400 mt-1 line-clamp-2 min-h-[32px]">
                        {s.description || 'Sem descrição cadastrada.'}
                      </p>
                    </div>

                    <div className="mt-4 pt-4 border-t border-slate-700/80 flex items-center justify-between text-xs text-slate-400">
                      <span className="flex items-center gap-1">
                        <i className="ph ph-users" /> {s.memberUids.length} participante(s)
                      </span>
                      <span className="font-semibold text-indigo-400 flex items-center gap-1">
                        Abrir <i className="ph ph-arrow-right" />
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        /* VISUALIZAÇÃO DETALHADA DO ESPAÇO SELECIONADO */
        <div className="space-y-6">
          {/* Banner de Acesso Histórico (Ex-Participante) */}
          {isHistoricalOnly && (
            <div className="bg-slate-800/90 border border-slate-600 rounded-2xl p-4 flex items-center gap-3 text-slate-200 text-sm">
              <i className="ph ph-clock-counter-clockwise text-xl text-slate-400 flex-shrink-0" />
              <div>
                <p className="font-bold text-white">Acesso Histórico de Ex-Participante (Somente Leitura)</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Você não possui mais acesso operacional a este espaço. Apenas seus registros históricos permanecem consultáveis. Operações de movimentação, alteração de participantes, convites e governança estão totalmente desabilitadas.
                </p>
              </div>
            </div>
          )}

          {/* Banner de Arquivamento */}
          {isArchived && (
            <div className="bg-amber-500/15 border border-amber-500/30 rounded-2xl p-4 flex items-center gap-3 text-amber-200 text-sm">
              <i className="ph ph-lock-key text-xl text-amber-400 flex-shrink-0" />
              <div>
                <p className="font-bold text-amber-300">Espaço Arquivado — Modo Somente Leitura</p>
                <p className="text-xs text-amber-200/80 mt-0.5">
                  Este espaço foi arquivado pelo criador. Não são permitidas novas movimentações, convites, alterações de membros ou cadastros operacionais. Todos os dados históricos permanecem íntegros para consulta.
                </p>
              </div>
            </div>
          )}

          {/* Banner de Dissolução Ativa */}
          {dissolutionReq && dissolutionReq.requestStatus === 'pending_author_responses' && (
            <div className="bg-rose-500/15 border border-rose-500/30 rounded-2xl p-4 flex items-center justify-between gap-4 text-rose-200 text-sm">
              <div className="flex items-center gap-3">
                <i className="ph ph-warning-octagon text-2xl text-rose-400 flex-shrink-0" />
                <div>
                  <p className="font-bold text-rose-300">Processo de Dissolução em Andamento (Prazo: 30 dias)</p>
                  <p className="text-xs text-rose-200/80 mt-0.5">
                    Data limite: {new Date(dissolutionReq.deadlineDate).toLocaleDateString()} às {new Date(dissolutionReq.deadlineDate).toLocaleTimeString()}.
                    Cada autor é soberano sobre a destinação dos seus registros. Se houver qualquer decisão pendente ao final dos 30 dias, a solicitação será automaticamente cancelada e os dados serão 100% preservados.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedTab('dissolution')}
                className="px-3 py-1.5 bg-rose-600 text-white rounded-xl text-xs font-bold hover:bg-rose-500 flex-shrink-0 cursor-pointer"
              >
                Ver Solicitação
              </button>
            </div>
          )}

          {/* Top Bar do Espaço */}
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setSelectedSpace(null)}
                  className="p-2 border border-slate-700 rounded-xl hover:bg-slate-700 text-slate-300 hover:text-white bg-slate-800 transition-colors cursor-pointer"
                  title="Voltar aos Espaços"
                >
                  <i className="ph ph-arrow-left text-lg" />
                </button>
                <div
                  className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl text-white shadow-sm shrink-0"
                  style={{ backgroundColor: selectedSpace.color || '#3b82f6' }}
                >
                  <i className={`ph ${selectedSpace.icon || 'ph-users-three'}`} />
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="flex items-center gap-3 flex-wrap">
                      <h2 className="text-xl font-bold text-white">{selectedSpace.name}</h2>
                      {spaces.length > 1 && (
                        <select
                          value={selectedSpace.id}
                          onChange={(e) => {
                            const target = spaces.find(s => s.id === e.target.value);
                            if (target) setSelectedSpace(target);
                          }}
                          className="bg-slate-900 border border-slate-700 text-xs text-white rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
                          title="Alternar entre espaços ativos"
                        >
                          {spaces.map(s => (
                            <option key={s.id} value={s.id}>
                              {s.name} {s.spaceStatus === 'archived' ? '(Arquivado)' : ''}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                    {isArchived && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                        Arquivado
                      </span>
                    )}
                    {isHistoricalOnly && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-700 text-slate-200 border border-slate-600">
                        Acesso Histórico
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {selectedSpace.description || 'Sem descrição cadastrada.'}
                  </p>
                </div>
              </div>

              {/* Ações de Governança no Espaço */}
              <div className="flex items-center gap-2 flex-wrap">
                {isActiveMember &&
                  onOpenSpaceAcquisitions &&
                  selectedSpace.enabledModules?.includes('acquisitions') !== false && (
                    <button
                      type="button"
                      onClick={() => onOpenSpaceAcquisitions(selectedSpace.id)}
                      className="px-3 py-2 rounded-xl text-xs font-semibold border border-emerald-500/40 text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <i className="ph ph-shopping-cart" />
                      Listas de Compras do Espaço
                    </button>
                  )}

                {isHistoricalOnly && (
                  <span className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-900 text-slate-300 border border-slate-700 flex items-center gap-1.5">
                    <i className="ph ph-eye" /> Modo Consulta Histórica
                  </span>
                )}

                {isActiveMember && isCreator && (
                  <>
                    <button
                      onClick={handleArchiveToggle}
                      className={`px-3 py-2 rounded-xl text-xs font-semibold border flex items-center gap-1.5 transition-colors cursor-pointer ${
                        isArchived
                          ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/15 hover:bg-emerald-500/25'
                          : 'border-amber-500/40 text-amber-300 bg-amber-500/15 hover:bg-amber-500/25'
                      }`}
                    >
                      <i className={`ph ${isArchived ? 'ph-lock-key-open' : 'ph-lock-key'}`} />
                      {isArchived ? 'Desarquivar Espaço' : 'Arquivar Espaço'}
                    </button>

                    <button
                      onClick={handleInitiateDissolution}
                      disabled={dissolutionReq?.requestStatus === 'pending_author_responses'}
                      className="px-3 py-2 rounded-xl text-xs font-semibold border border-rose-500/40 text-rose-300 bg-rose-500/15 hover:bg-rose-500/25 flex items-center gap-1.5 transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      <i className="ph ph-trash" />
                      Solicitar Dissolução
                    </button>
                  </>
                )}

                {isActiveMember && !isCreator && currentUserMember?.participationStatus === 'active' && !isArchived && (
                  <button
                    onClick={handleLeaveSpace}
                    className="px-3 py-2 rounded-xl text-xs font-semibold border border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white bg-slate-800 flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <i className="ph ph-sign-out" />
                    Sair do Espaço
                  </button>
                )}
              </div>
            </div>

            {/* Abas Internas */}
            <div className="flex items-center gap-2 border-b border-slate-700/80 mt-6 pt-2 overflow-x-auto">
              <button
                onClick={() => setSelectedTab('expenses')}
                className={`pb-3 px-3 text-xs font-bold transition-all border-b-2 flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  selectedTab === 'expenses'
                    ? 'border-indigo-400 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <i className="ph ph-receipt text-base" />
                Despesas e Rateios
              </button>

              <button
                onClick={() => setSelectedTab('liabilities')}
                className={`pb-3 px-3 text-xs font-bold transition-all border-b-2 flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  selectedTab === 'liabilities'
                    ? 'border-indigo-400 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <i className="ph ph-hand-coins text-base" />
                Minhas Obrigações
              </button>

              <button
                onClick={() => setSelectedTab('validations')}
                className={`pb-3 px-3 text-xs font-bold transition-all border-b-2 flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  selectedTab === 'validations'
                    ? 'border-indigo-400 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <i className="ph ph-check-square-offset text-base" />
                Validações
              </button>

              <button
                onClick={() => setSelectedTab('refunds')}
                className={`pb-3 px-3 text-xs font-bold transition-all border-b-2 flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  selectedTab === 'refunds'
                    ? 'border-indigo-400 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <i className="ph ph-arrows-clockwise text-base" />
                Reembolsos
              </button>

              <button
                onClick={() => setSelectedTab('custody')}
                className={`pb-3 px-3 text-xs font-bold transition-all border-b-2 flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  selectedTab === 'custody'
                    ? 'border-indigo-400 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <i className="ph ph-hand-holding text-base" />
                Custódia & Adiantamentos
              </button>

              <button
                onClick={() => setSelectedTab('members')}
                className={`pb-3 px-3 text-xs font-bold transition-all border-b-2 flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  selectedTab === 'members'
                    ? 'border-indigo-400 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <i className="ph ph-users text-base" />
                Participantes ({members.length})
              </button>

              <button
                onClick={() => setSelectedTab('invites')}
                className={`pb-3 px-3 text-xs font-bold transition-all border-b-2 flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  selectedTab === 'invites'
                    ? 'border-indigo-400 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <i className="ph ph-ticket text-base" />
                Convites ({invites.length})
              </button>

              <button
                onClick={() => setSelectedTab('audit')}
                className={`pb-3 px-3 text-xs font-bold transition-all border-b-2 flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  selectedTab === 'audit'
                    ? 'border-indigo-400 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <i className="ph ph-clock-counter-clockwise text-base" />
                Auditoria e Histórico ({auditEvents.length})
              </button>

              <button
                onClick={() => setSelectedTab('dissolution')}
                className={`pb-3 px-3 text-xs font-bold transition-all border-b-2 flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  selectedTab === 'dissolution'
                    ? 'border-indigo-400 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <i className="ph ph-shield-warning text-base" />
                Governança e Dissolução
              </button>
            </div>
          </div>

          {/* CONTEÚDO DA ABA SELECIONADA */}

          {/* ABAS FINANCEIRAS DAS FASES 6 E 7 */}
          {(selectedTab === 'expenses' ||
            selectedTab === 'liabilities' ||
            selectedTab === 'validations' ||
            selectedTab === 'refunds' ||
            selectedTab === 'custody') && (
            <SharedFinanceSectionV3
              space={selectedSpace}
              userId={userId}
              userName={userName}
              isDemo={isDemo}
              refreshTrigger={refreshTrigger}
              onOpenNewTransaction={onOpenNewTransaction}
              activeTab={selectedTab}
              onTabChange={(tab) => setSelectedTab(tab)}
              onFeedback={(type, text) => setFeedbackMessage({ type, text })}
            />
          )}

          {/* ABA: PARTICIPANTES */}
          {selectedTab === 'members' && (
            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Participantes do Espaço
                  </h3>
                  <p className="text-xs text-slate-400">
                    Membros ativos têm acesso operacional. A remoção de participante revoga imediatamente o acesso sem apagar seu histórico.
                  </p>
                </div>
                {isOwnerOrAdmin && !isArchived && (
                  <button
                    onClick={() => {
                      setModalError(null);
                      setGeneratedInviteResult(null);
                      setIsInviteModalOpen(true);
                    }}
                    className="px-3 py-1.5 bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 rounded-xl text-xs font-bold hover:bg-indigo-500/30 flex items-center gap-1.5 cursor-pointer"
                  >
                    <i className="ph ph-user-plus" /> Convidar Membro
                  </button>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-900/80 border-y border-slate-700/80 text-slate-400 font-semibold uppercase tracking-wider">
                    <tr>
                      <th className="py-2.5 px-3">Participante</th>
                      <th className="py-2.5 px-3">Papel</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3">Ingresso</th>
                      <th className="py-2.5 px-3 text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/70">
                    {members.map((m) => {
                      const isTargetCreator = m.uid === selectedSpace.creatorUid;
                      const isMe = m.uid === userId;
                      return (
                        <tr key={m.id} className="hover:bg-slate-800/50">
                          <td className="py-3 px-3">
                            <div className="font-bold text-white flex items-center gap-1.5">
                              {m.displayName}
                              {isMe && (
                                <span className="text-[10px] bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-1.5 py-0.2 rounded font-normal">
                                  Você
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-400 font-mono">
                              UID: {m.uid.substring(0, 10)}...
                            </div>
                          </td>
                          <td className="py-3 px-3">
                            {isOwnerOrAdmin && !isTargetCreator && !isArchived ? (
                              <select
                                value={m.role}
                                onChange={(e) =>
                                  handleChangeRole(m.uid, e.target.value as SpaceMemberRole)
                                }
                                className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs font-semibold text-slate-200"
                              >
                                <option value="member">Membro</option>
                                <option value="admin">Administrador</option>
                                <option value="owner">Proprietário</option>
                              </select>
                            ) : (
                              <span className="font-semibold text-slate-200 capitalize">
                                {m.role === 'owner' ? 'Proprietário' : m.role === 'admin' ? 'Administrador' : 'Membro'}
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-3">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                                m.participationStatus === 'active'
                                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                  : m.participationStatus === 'removed_by_admin'
                                  ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                                  : 'bg-slate-700/80 text-slate-300 border-slate-600'
                              }`}
                            >
                              {m.participationStatus === 'active'
                                ? 'Ativo'
                                : m.participationStatus === 'removed_by_admin'
                                ? 'Removido'
                                : m.participationStatus === 'voluntary_exit'
                                ? 'Saiu'
                                : 'Convidado'}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-slate-400">
                            {m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : '—'}
                          </td>
                          <td className="py-3 px-3 text-right">
                            {isOwnerOrAdmin && !isTargetCreator && !isMe && m.participationStatus === 'active' && !isArchived && (
                              <button
                                onClick={() => handleRemoveMember(m.uid)}
                                className="text-rose-400 hover:text-rose-300 font-semibold cursor-pointer"
                                title="Remover do Espaço"
                              >
                                Remover
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

          {/* ABA 2: CONVITES */}
          {selectedTab === 'invites' && (
            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <h3 className="text-sm font-bold text-white">Convites do Espaço</h3>
                  <p className="text-xs text-slate-400">
                    Convites utilizam hash criptográfico SHA-256 e controle de uso único atômico.
                  </p>
                </div>
                {isOwnerOrAdmin && !isArchived && (
                  <button
                    onClick={() => {
                      setModalError(null);
                      setGeneratedInviteResult(null);
                      setIsInviteModalOpen(true);
                    }}
                    className="px-3 py-1.5 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-500 flex items-center gap-1.5 cursor-pointer"
                  >
                    <i className="ph ph-plus" /> Novo Convite
                  </button>
                )}
              </div>

              {invites.length === 0 ? (
                <div className="py-8 text-center text-slate-400 text-xs">
                  Nenhum convite emitido para este espaço.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-900/80 border-y border-slate-700/80 text-slate-400 font-semibold uppercase tracking-wider">
                      <tr>
                        <th className="py-2.5 px-3">Destinatário</th>
                        <th className="py-2.5 px-3">Papel Previsto</th>
                        <th className="py-2.5 px-3">Status</th>
                        <th className="py-2.5 px-3">Expira Em</th>
                        <th className="py-2.5 px-3 text-right">Ações</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/70">
                      {invites.map((inv) => (
                        <tr key={inv.id} className="hover:bg-slate-800/50">
                          <td className="py-3 px-3">
                            <span className="font-semibold text-white">
                              {inv.invitedEmail || 'Qualquer pessoa com o link'}
                            </span>
                            <div className="text-[10px] text-slate-400 font-mono">
                              Hash: {inv.id.substring(0, 16)}...
                            </div>
                          </td>
                          <td className="py-3 px-3 font-semibold text-slate-200 capitalize">
                            {inv.invitedRole}
                          </td>
                          <td className="py-3 px-3">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                                inv.tokenStatus === 'pending'
                                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                                  : inv.tokenStatus === 'accepted'
                                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                  : 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                              }`}
                            >
                              {inv.tokenStatus === 'pending'
                                ? 'Pendente'
                                : inv.tokenStatus === 'accepted'
                                ? 'Aceito'
                                : inv.tokenStatus === 'revoked'
                                ? 'Revogado'
                                : inv.tokenStatus}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-slate-400">
                            {new Date(inv.expiresAt).toLocaleDateString()}
                          </td>
                          <td className="py-3 px-3 text-right">
                            {isOwnerOrAdmin && inv.tokenStatus === 'pending' && !isArchived && (
                              <button
                                onClick={() => handleRevokeInvite(inv.id)}
                                className="text-rose-400 hover:text-rose-300 font-semibold cursor-pointer"
                              >
                                Revogar
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ABA 3: AUDITORIA E HISTÓRICO */}
          {selectedTab === 'audit' && (
            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-6 shadow-sm space-y-4">
              <div>
                <h3 className="text-sm font-bold text-white">
                  Trilha de Auditoria e Governança Imutável
                </h3>
                <p className="text-xs text-slate-400">
                  Eventos gravados cronologicamente e protegidos contra mutação ou exclusão.
                </p>
              </div>

              {auditEvents.length === 0 ? (
                <div className="py-8 text-center text-slate-400 text-xs">
                  Nenhum evento registrado ainda.
                </div>
              ) : (
                <div className="space-y-3">
                  {auditEvents.map((evt) => (
                    <div
                      key={evt.id}
                      className="border border-slate-700/80 bg-slate-900/40 rounded-xl p-3 text-xs flex items-start gap-3 hover:bg-slate-800/80 transition-colors"
                    >
                      <div className="w-8 h-8 rounded-lg bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 flex items-center justify-center text-base flex-shrink-0 mt-0.5">
                        <i className="ph ph-shield-check" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="font-bold text-white">
                            {evt.eventType.replace(/_/g, ' ').toUpperCase()}
                          </span>
                          <span className="text-[11px] text-slate-400">
                            {new Date(evt.timestamp).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-slate-300 mt-0.5">
                          Executado por: <span className="font-semibold text-white">{evt.performedByName}</span>
                          {evt.targetName && (
                            <span>
                              {' '}
                              sobre <span className="font-semibold text-white">{evt.targetName}</span>
                            </span>
                          )}
                        </p>
                        {evt.details && (
                          <div className="mt-1 text-[11px] text-slate-400 font-mono bg-slate-950/70 p-1.5 rounded border border-slate-700/60 overflow-x-auto">
                            {JSON.stringify(evt.details)}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ABA 4: GOVERNANÇA E DISSOLUÇÃO */}
          {selectedTab === 'dissolution' && (
            <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-6 shadow-sm space-y-6">
              <div>
                <h3 className="text-base font-bold text-white">
                  Processo Formal de Dissolução Definitiva (v3.1)
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  Em estrita conformidade com as regras aprovadas (D5, A4 e A5), a exclusão definitiva exige a autorização do criador e colhe individualmente a manifestação de cada autor.
                </p>
              </div>

              {/* Status do Processo */}
              {!dissolutionReq ? (
                <div className="bg-slate-900/60 border border-slate-700 rounded-xl p-6 text-center">
                  <i className="ph ph-info text-2xl text-slate-400 mb-2" />
                  <p className="text-sm font-semibold text-slate-200">
                    Nenhuma solicitação de dissolução ativa no momento.
                  </p>
                  <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
                    O criador original do espaço pode iniciar a solicitação caso o grupo decida encerrar as atividades compartilhadas.
                  </p>
                  {isActiveMember && isCreator && !isArchived && (
                    <button
                      onClick={handleInitiateDissolution}
                      className="mt-4 px-4 py-2 bg-rose-600 text-white rounded-xl text-xs font-bold hover:bg-rose-500 inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <i className="ph ph-trash" /> Iniciar Solicitação de Dissolução
                    </button>
                  )}
                </div>
              ) : (
                <div className="border border-slate-700 rounded-xl p-5 space-y-4 bg-slate-900/40">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-700/80 pb-3">
                    <div>
                      <span className="text-[11px] font-bold text-slate-400 uppercase">
                        Status do Processo
                      </span>
                      <p className="text-base font-bold text-white mt-0.5">
                        {dissolutionReq.requestStatus === 'pending_author_responses'
                          ? 'Aguardando Manifestação dos Autores'
                          : dissolutionReq.requestStatus === 'fully_approved_ready'
                          ? 'Totalmente Aprovado — Pronto para Execução'
                          : dissolutionReq.requestStatus === 'auto_cancelled_timeout'
                          ? 'Cancelado Automaticamente (Timeout de 30 dias)'
                          : 'Cancelado pelo Criador'}
                      </p>
                    </div>

                    <div className="text-right">
                      <span className="text-[11px] font-bold text-slate-400 uppercase">
                        Prazo Limite (30 dias)
                      </span>
                      <p className="text-xs font-semibold text-slate-200 mt-0.5">
                        {new Date(dissolutionReq.deadlineDate).toLocaleDateString()}
                      </p>
                    </div>
                  </div>

                  {dissolutionReq.cancellationReason && (
                    <div className="p-3 bg-amber-500/15 text-amber-200 text-xs rounded-xl border border-amber-500/30">
                      <strong>Motivo do Cancelamento:</strong> {dissolutionReq.cancellationReason}
                    </div>
                  )}

                  {/* Tabela de Decisões dos Autores */}
                  <div>
                    <h4 className="text-xs font-bold text-slate-200 mb-2 uppercase tracking-wider">
                      Decisões Individuais dos Autores
                    </h4>
                    <div className="divide-y divide-slate-700/70 border border-slate-700/80 rounded-xl overflow-hidden text-xs">
                      {Object.entries(dissolutionReq.authorDestinations).map(
                        ([authorUid, record]: [string, any]) => {
                          const authorMember = members.find((m) => m.uid === authorUid);
                          const isAuthorMe = authorUid === userId;
                          return (
                            <div
                              key={authorUid}
                              className="p-3 flex items-center justify-between gap-2 hover:bg-slate-800/80"
                            >
                              <div>
                                <span className="font-bold text-white">
                                  {authorMember?.displayName || authorUid}
                                </span>
                                {isAuthorMe && (
                                  <span className="ml-1.5 text-[10px] bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-1.5 py-0.2 rounded font-semibold">
                                    Você
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-3">
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                                    record.decision === 'pending'
                                      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                                      : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                  }`}
                                >
                                  {record.decision === 'pending'
                                    ? 'Pendente'
                                    : record.decision === 'migrate_to_existing_personal_space'
                                    ? 'Migrar para individual existente'
                                    : record.decision === 'create_personal_space_and_migrate'
                                    ? 'Criar individual e migrar'
                                    : record.decision === 'archive_or_hide'
                                    ? 'Arquivar/ocultar'
                                    : 'Excluir definitivamente'}
                                </span>

                                {isAuthorMe &&
                                  dissolutionReq.requestStatus === 'pending_author_responses' && (
                                    <button
                                      onClick={() => setIsDecisionModalOpen(true)}
                                      className="text-xs font-bold text-indigo-400 hover:text-indigo-300 cursor-pointer"
                                    >
                                      Alterar Decisão
                                    </button>
                                  )}
                              </div>
                            </div>
                          );
                        }
                      )}
                    </div>
                  </div>

                  {/* Ações da Solicitação */}
                  <div className="flex items-center justify-between pt-2">
                    {isActiveMember && isCreator && dissolutionReq.requestStatus === 'pending_author_responses' && (
                      <button
                        onClick={handleCancelDissolution}
                        className="px-3 py-1.5 border border-slate-700 rounded-xl text-xs font-bold text-slate-300 hover:bg-slate-700 hover:text-white bg-slate-800 cursor-pointer"
                      >
                        Cancelar Solicitação
                      </button>
                    )}

                    {dissolutionReq.authorDestinations[userId] &&
                      dissolutionReq.requestStatus === 'pending_author_responses' && (
                        <button
                          onClick={() => setIsDecisionModalOpen(true)}
                          className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-500 ml-auto cursor-pointer"
                        >
                          Definir Destino dos Meus Registros
                        </button>
                      )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* MODAL 1: CRIAR ESPAÇO */}
      {isCreateSpaceModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-white">Novo Espaço Compartilhado</h3>
              <button
                type="button"
                onClick={closeCreateSpaceModal}
                disabled={isCreatingSpace}
                className="text-slate-400 hover:text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                title={isCreatingSpace ? 'Aguarde a conclusão da criação' : 'Fechar modal'}
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            {modalError && (
              <div
                role="alert"
                className="mb-3 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-200 text-xs flex items-center gap-2"
              >
                <i className="ph ph-warning-circle text-rose-400 text-base shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <form onSubmit={handleCreateSpace} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-200 mb-1">
                  Nome do Espaço *
                </label>
                <input
                  type="text"
                  required
                  disabled={isCreatingSpace}
                  value={newSpaceName}
                  onChange={(e) => setNewSpaceName(e.target.value)}
                  placeholder="Ex: República dos Amigos, Casal, Viagem 2027"
                  className="w-full text-xs px-3 py-2 bg-slate-800 border border-slate-700 text-white placeholder-slate-500 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:outline-none disabled:opacity-60"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-200 mb-1">Descrição</label>
                <textarea
                  rows={2}
                  disabled={isCreatingSpace}
                  value={newSpaceDesc}
                  onChange={(e) => setNewSpaceDesc(e.target.value)}
                  placeholder="Finalidade e governança do espaço..."
                  className="w-full text-xs px-3 py-2 bg-slate-800 border border-slate-700 text-white placeholder-slate-500 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:outline-none disabled:opacity-60"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-200 mb-1">Cor</label>
                  <input
                    type="color"
                    disabled={isCreatingSpace}
                    value={newSpaceColor}
                    onChange={(e) => setNewSpaceColor(e.target.value)}
                    className="w-full h-9 rounded-xl bg-slate-800 border border-slate-700 cursor-pointer p-1 disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-200 mb-1">Ícone</label>
                  <select
                    disabled={isCreatingSpace}
                    value={newSpaceIcon}
                    onChange={(e) => setNewSpaceIcon(e.target.value)}
                    className="w-full h-9 text-xs px-2 bg-slate-800 border border-slate-700 text-white rounded-xl focus:ring-2 focus:ring-indigo-500 focus:outline-none disabled:opacity-60"
                  >
                    <option value="ph-users-three">Grupo / Pessoas</option>
                    <option value="ph-house-line">República / Moradia</option>
                    <option value="ph-airplane-tilt">Viagem</option>
                    <option value="ph-heart">Casal / Parceria</option>
                    <option value="ph-briefcase">Projeto</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-200 mb-1">
                  Orçamento Mensal Estimado (Centavos / Opcional)
                </label>
                <input
                  type="number"
                  min="0"
                  step="100"
                  disabled={isCreatingSpace}
                  value={newSpaceBudgetCents}
                  onChange={(e) => setNewSpaceBudgetCents(parseInt(e.target.value) || 0)}
                  className="w-full text-xs px-3 py-2 bg-slate-800 border border-slate-700 text-white placeholder-slate-500 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:outline-none disabled:opacity-60"
                  placeholder="Ex: 500000 para R$ 5.000,00"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-700/80">
                <button
                  type="button"
                  onClick={closeCreateSpaceModal}
                  disabled={isCreatingSpace}
                  className="px-4 py-2 border border-slate-700 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-700 hover:text-white bg-slate-800 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isCreatingSpace}
                  aria-busy={isCreatingSpace}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-500 shadow-sm flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isCreatingSpace && <i className="ph ph-spinner animate-spin" />}
                  {isCreatingSpace ? 'Criando...' : 'Criar Espaço'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: NOVO CONVITE */}
      {isInviteModalOpen && selectedSpace && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-white">Convidar para o Espaço</h3>
              <button
                onClick={() => setIsInviteModalOpen(false)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            {!generatedInviteResult ? (
              <form onSubmit={handleCreateInvite} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-200 mb-1">
                    E-mail do Convidado (Opcional)
                  </label>
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="amigo@exemplo.com"
                    className="w-full text-xs px-3 py-2 bg-slate-800 border border-slate-700 text-white placeholder-slate-500 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                  <p className="text-[11px] text-slate-400 mt-1">
                    Se omitido, qualquer pessoa autenticada com o token poderá ingressar.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-200 mb-1">Papel</label>
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as SpaceMemberRole)}
                      className="w-full text-xs px-3 py-2 bg-slate-800 border border-slate-700 text-white rounded-xl focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                    >
                      <option value="member">Membro</option>
                      <option value="admin">Administrador</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-200 mb-1">
                      Validade (Dias)
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="90"
                      value={inviteExpDays}
                      onChange={(e) => setInviteExpDays(parseInt(e.target.value) || 15)}
                      className="w-full text-xs px-3 py-2 bg-slate-800 border border-slate-700 text-white rounded-xl focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t border-slate-700/80">
                  <button
                    type="button"
                    onClick={() => setIsInviteModalOpen(false)}
                    className="px-4 py-2 border border-slate-700 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-700 hover:text-white bg-slate-800 cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-500 cursor-pointer"
                  >
                    Gerar Token de Convite
                  </button>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                <div className="p-3 bg-emerald-500/15 text-emerald-200 text-xs rounded-xl border border-emerald-500/30">
                  <p className="font-bold text-emerald-300">Convite Gerado com Sucesso!</p>
                  <p className="text-[11px] mt-0.5 text-emerald-200/80">
                    O token abaixo foi criptografado com hash SHA-256 no banco de dados. Compartilhe-o com o convidado.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-200 mb-1">Token de Convite</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={generatedInviteResult.rawToken}
                      className="w-full text-xs font-mono bg-slate-800 px-3 py-2 border border-slate-700 rounded-xl text-white select-all"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(generatedInviteResult.rawToken);
                        setFeedbackMessage({ type: 'success', text: 'Token de convite copiado!' });
                      }}
                      className="px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-xl text-xs font-bold cursor-pointer"
                    >
                      Copiar
                    </button>
                  </div>
                </div>

                <div className="flex justify-end pt-2 border-t border-slate-700/80">
                  <button
                    onClick={() => {
                      setIsInviteModalOpen(false);
                      setGeneratedInviteResult(null);
                    }}
                    className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-500 cursor-pointer"
                  >
                    Concluído
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL 3: ACEITAR CONVITE */}
      {isAcceptModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-white">Aceitar Convite de Espaço</h3>
              <button
                onClick={() => setIsAcceptModalOpen(false)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-200 mb-1">
                  Cole o Token de Convite
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={acceptTokenInput}
                    onChange={(e) => setAcceptTokenInput(e.target.value)}
                    placeholder="tok_..."
                    className="w-full text-xs font-mono px-3 py-2 bg-slate-800 border border-slate-700 text-white placeholder-slate-500 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleCheckTokenPreview}
                    className="px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-xl text-xs font-bold flex-shrink-0 cursor-pointer"
                  >
                    Verificar
                  </button>
                </div>
              </div>

              {invitePreview && (
                <div className="p-3 bg-indigo-950/40 border border-indigo-500/40 rounded-xl text-xs space-y-1">
                  <p className="font-bold text-white">Espaço: {invitePreview.spaceName}</p>
                  <p className="text-indigo-200">
                    Convidado por: <span className="font-semibold text-white">{invitePreview.invitedByName}</span>
                  </p>
                  <p className="text-indigo-200">
                    Papel atribuído: <span className="font-semibold text-white capitalize">{invitePreview.invitedRole}</span>
                  </p>
                  <p className="text-indigo-300 text-[11px]">
                    Válido até: {new Date(invitePreview.expiresAt).toLocaleDateString()}
                  </p>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-700/80">
                <button
                  type="button"
                  onClick={() => setIsAcceptModalOpen(false)}
                  className="px-4 py-2 border border-slate-700 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-700 hover:text-white bg-slate-800 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleAcceptInviteSubmit}
                  disabled={!acceptTokenInput.trim()}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-500 disabled:opacity-50 cursor-pointer"
                >
                  Ingressar no Espaço
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 4: DECISÃO DO AUTOR NA DISSOLUÇÃO */}
      {isDecisionModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 rounded-2xl max-w-lg w-full max-h-[90dvh] overflow-y-auto p-6 shadow-2xl border border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-white">
                Destinação dos Seus Registros no Espaço
              </h3>
              <button
                onClick={() => setIsDecisionModalOpen(false)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            <div className="space-y-4">
              <p className="text-xs text-slate-300">
                Em respeito à soberania de cada autor, você escolhe livremente o destino dos registros cadastrados por você neste espaço:
              </p>

              <div className="space-y-2">
                {[
                  {
                    value: 'migrate_to_existing_personal_space',
                    label: 'Migrar para um espaço individual existente',
                    desc: 'Preserva despesas e registros transferindo a titularidade para um espaço pessoal seu.',
                  },
                  {
                    value: 'create_personal_space_and_migrate',
                    label: 'Criar um novo espaço individual e migrar',
                    desc: 'Cria automaticamente um novo espaço privado e aloca todos os seus lançamentos nele.',
                  },
                  {
                    value: 'archive_or_hide',
                    label: 'Arquivar e ocultar registros',
                    desc: 'Mantém os registros congelados em modo histórico e desativa sua exibição operacional.',
                  },
                  {
                    value: 'delete_permanently',
                    label: 'Excluir definitivamente meus registros',
                    desc: 'Remove seus dados autorais do sistema, mantendo apenas vínculos contábeis necessários.',
                  },
                ].map((opt) => (
                  <label
                    key={opt.value}
                    className={`block p-3 border rounded-xl cursor-pointer text-xs transition-all ${
                      selectedDecision === opt.value
                        ? 'border-indigo-500 bg-indigo-950/40'
                        : 'border-slate-700 hover:bg-slate-800'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="authorDecision"
                        value={opt.value}
                        checked={selectedDecision === opt.value}
                        onChange={(e) =>
                          setSelectedDecision(e.target.value as AuthorDataDestinationDecision)
                        }
                        className="mt-0.5 text-indigo-600"
                      />
                      <div>
                        <span className="font-bold text-white">{opt.label}</span>
                        <p className="text-slate-400 text-[11px] mt-0.5">{opt.desc}</p>
                      </div>
                    </div>
                  </label>
                ))}
              </div>

              {selectedDecision === 'migrate_to_existing_personal_space' && (
                <div>
                  <label className="block text-xs font-bold text-slate-200 mb-1">
                    ID do Espaço Individual de Destino (Opcional)
                  </label>
                  <input
                    type="text"
                    value={targetSpaceIdInput}
                    onChange={(e) => setTargetSpaceIdInput(e.target.value)}
                    placeholder="space_..."
                    className="w-full text-xs px-3 py-2 bg-slate-800 border border-slate-700 text-white placeholder-slate-500 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-700/80">
                <button
                  type="button"
                  onClick={() => setIsDecisionModalOpen(false)}
                  className="px-4 py-2 border border-slate-700 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-700 hover:text-white bg-slate-800 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleSubmitAuthorDecision}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-500 cursor-pointer"
                >
                  Confirmar Minha Decisão
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DRAWER / MODAL DE NOTIFICAÇÕES */}
      {isNotifOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-700 max-h-[85dvh] flex flex-col">
            <div className="flex items-center justify-between mb-4 border-b border-slate-700/80 pb-3">
              <div className="flex items-center gap-2">
                <i className="ph ph-bell text-lg text-indigo-400" />
                <h3 className="text-base font-bold text-white">Notificações do Espaço</h3>
              </div>
              <button
                onClick={() => setIsNotifOpen(false)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <i className="ph ph-x text-lg" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {notifications.length === 0 ? (
                <div className="py-12 text-center text-slate-400 text-xs">
                  Nenhuma notificação recebida.
                </div>
              ) : (
                notifications.map((n) => (
                  <div
                    key={n.id}
                    onClick={() => markNotificationAsRead(userId, n.id, isDemo)}
                    className={`p-3 rounded-xl border text-xs cursor-pointer transition-all ${
                      n.read
                        ? 'border-slate-800 bg-slate-900/40 text-slate-400'
                        : 'border-indigo-500/40 bg-indigo-950/40 text-white font-medium'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1 gap-2">
                      <span className="font-bold text-indigo-300 truncate">{n.title}</span>
                      <span className="text-[10px] text-slate-400 flex-shrink-0">
                        {new Date(n.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-300">{n.message}</p>
                  </div>
                ))
              )}
            </div>

            <div className="pt-3 border-t border-slate-700/80 flex justify-end">
              <button
                onClick={() => setIsNotifOpen(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-xl text-xs font-bold cursor-pointer"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
