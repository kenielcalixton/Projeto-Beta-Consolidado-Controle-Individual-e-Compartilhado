import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AcquisitionItem,
  AcquisitionList,
  GoalQuote,
  ItemStage,
  ListType,
  TaxonomyGroup,
  UserProfile,
  Workspace,
} from '../../types/acquisitions';
import {
  DEFAULT_USER_PROFILE,
  INITIAL_ITEMS,
  INITIAL_LISTS,
  INITIAL_TAXONOMY_GROUPS,
  INITIAL_WORKSPACES,
} from '../../data/acquisitionsSeedData';
import { Space } from '../../types/finance';
import {
  addGoalDeposit,
  adjustItemStock,
  confirmCartCheckout,
  convertWishToGoal,
  formatCurrencyBRL,
  getStagesForListType,
  returnConfirmedToStock,
  revertConfirmedCheckout,
} from '../../utils/stateMachine';
import {
  ADMIN_USER_UID,
  deleteItemFromFirestore,
  deleteListFromFirestore,
  deleteTaxonomyGroupFromFirestore,
  deleteWorkspaceFromFirestore,
  fetchAcceptedWorkspacesFromFirestore,
  isAcquisitionAdminUid,
  recordProductInSubcollection,
  saveItemToFirestore,
  saveListToFirestore,
  saveTaxonomyGroupToFirestore,
  saveWorkspaceToFirestore,
  subscribeToIndividualLists,
  subscribeToListItems,
  subscribeToSharedLists,
  upsertUserDocument,
} from '../../services/acquisitionsFirebase';
import {
  recordAcquisitionPurchase,
  reverseAcquisitionPurchase,
  recordStockMovement,
  recordAcquisitionQuote,
  recordAcquisitionDeposit,
} from '../../services/acquisitionsService';
import { DashboardOverviewView } from './DashboardOverviewView';
import { HubDashboardView } from './HubDashboardView';
import { WorkspaceBoardView } from './WorkspaceBoardView';
import { SettingsView } from './SettingsView';
import { AdminEnvironmentView } from './AdminEnvironmentView';
import {
  LayoutDashboard,
  FolderKanban,
  Settings,
  ShieldCheck,
} from 'lucide-react';

type ActiveRoute =
  | 'dashboard'
  | 'workspaces'
  | 'workspace_detail'
  | 'settings'
  | 'admin';

interface AcquisitionsModuleViewProps {
  sharedUser: {
    uid: string;
    name: string;
    email: string;
    isDemo: boolean;
  };
  onLogout: () => void;
  initialWorkspaceIdToOpen?: string | null;
  onClearInitialWorkspace?: () => void;
  openCreateListTrigger?: number;
  unifiedSpaces?: Space[];
  onOpenManageSpaces?: () => void;
  onOpenCreateSpace?: (preset: 'acquisitions' | 'both') => void;
  onCreateExpenseFromPurchase?: (payload: {
    description: string;
    amount: number;
    storeName?: string;
  }) => void;
}

export const AcquisitionsModuleView: React.FC<AcquisitionsModuleViewProps> = ({
  sharedUser,
  onLogout,
  initialWorkspaceIdToOpen,
  onClearInitialWorkspace,
  openCreateListTrigger,
  unifiedSpaces,
  onOpenManageSpaces,
  onOpenCreateSpace,
  onCreateExpenseFromPurchase,
}) => {
  const personalWorkspaceId = `ws_personal_${sharedUser.uid}`;
  const lsListsKey = `app_aquisicoes_lists_${sharedUser.uid}`;
  const lsItemsKey = `app_aquisicoes_items_${sharedUser.uid}`;
  const lsTaxKey = `app_aquisicoes_taxonomy_${sharedUser.uid}`;

  const [currentUser, setCurrentUser] = useState<UserProfile>(() => {
    const saved = localStorage.getItem('app_aquisicoes_user');
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as UserProfile;
        if (parsed.email?.toLowerCase() === sharedUser.email.toLowerCase()) {
          return {
            ...parsed,
            uid: sharedUser.uid,
            email: sharedUser.email,
            displayName: sharedUser.name || parsed.displayName,
            isAdmin: isAcquisitionAdminUid(sharedUser.uid) || Boolean(parsed.isAdmin),
          };
        }
      } catch {
        // ignore parse errors
      }
    }
    return {
      uid: sharedUser.uid,
      email: sharedUser.email,
      displayName: sharedUser.name || DEFAULT_USER_PROFILE.displayName,
      isAdmin: isAcquisitionAdminUid(sharedUser.uid),
    };
  });

  // Sync when sharedUser changes in parent App.tsx
  useEffect(() => {
    setCurrentUser((prev) => ({
      ...prev,
      uid: sharedUser.uid,
      email: sharedUser.email,
      displayName: sharedUser.name || prev.displayName,
      isAdmin: isAcquisitionAdminUid(sharedUser.uid) || Boolean(prev.isAdmin),
    }));
  }, [sharedUser.uid, sharedUser.email, sharedUser.name]);

  // Core Application State (with localStorage persistence + Firestore sync)
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => {
    const saved = localStorage.getItem('app_aquisicoes_workspaces');
    return saved ? JSON.parse(saved) : [];
  });

  // Espaço Individual Permanente + Espaços Compartilhados Unificados
  const effectiveWorkspaces: Workspace[] = React.useMemo(() => {
    const personalWs: Workspace = {
      id: personalWorkspaceId,
      name: 'Minhas Listas Individuais',
      description: 'Listas de compras recorrentes, objetivos e desejos de uso exclusivo seu.',
      type: 'Individual',
      ownerUid: sharedUser.uid,
      ownerEmail: (sharedUser.email || '').toLowerCase(),
      acceptedMemberEmails: [(sharedUser.email || '').toLowerCase()].filter(Boolean),
      acceptedMemberUids: [sharedUser.uid],
      members: [
        {
          uid: sharedUser.uid,
          email: (sharedUser.email || '').toLowerCase(),
          name: sharedUser.name || 'Titular',
          role: 'Admin' as const,
          status: 'Aceito' as const,
        },
      ],
      createdAt: '2025-01-01T00:00:00.000Z',
    };

    if (unifiedSpaces !== undefined) {
      const acqSpaces = unifiedSpaces.filter(
        (sp) => !sp.enabledModules || sp.enabledModules.includes('acquisitions')
      );

      const mappedUnified: Workspace[] = acqSpaces.map((sp) => {
        const isOwner =
          sp.ownerEmail?.toLowerCase() === sharedUser.email.toLowerCase();
        const acceptedEmails = Array.from(
          new Set([
            (sp.ownerEmail || sharedUser.email).toLowerCase(),
            ...(sp.participantEmails || []).map((e) => e.toLowerCase()),
            ...sp.participants
              .filter((p) => p.status === 'active')
              .map((p) => p.email.toLowerCase()),
          ])
        );

        const membersList = [
          {
            uid: sp.ownerId || (isOwner ? sharedUser.uid : undefined),
            email: (sp.ownerEmail || sharedUser.email).toLowerCase(),
            name: isOwner ? sharedUser.name : 'Proprietário',
            role: 'Admin' as const,
            status: 'Aceito' as const,
          },
          ...sp.participants
            .filter(
              (p) =>
                p.email.toLowerCase() !==
                (sp.ownerEmail || sharedUser.email).toLowerCase()
            )
            .map((p) => ({
              uid: p.uid,
              email: p.email.toLowerCase(),
              name: p.name,
              role: 'Membro' as const,
              status: (p.status === 'active' ? 'Aceito' : 'Pendente') as any,
            })),
        ];

        const acceptedUids = Array.from(
          new Set(
            [
              sp.ownerId || (isOwner ? sharedUser.uid : ''),
              ...sp.participants
                .filter((p) => p.status === 'active' && p.uid)
                .map((p) => p.uid as string),
            ].filter(Boolean)
          )
        );

        return {
          id: sp.id,
          name: sp.name,
          description: sp.description || '',
          type:
            sp.participants.length > 1
              ? ('Compartilhado' as const)
              : ('Individual' as const),
          ownerUid: sp.ownerId || (isOwner ? sharedUser.uid : 'shared_owner'),
          ownerEmail: sp.ownerEmail || sharedUser.email,
          acceptedMemberEmails: acceptedEmails,
          acceptedMemberUids: acceptedUids,
          members: membersList,
          monthlyBudget: sp.monthlyBudget,
          createdAt: sp.createdAt
            ? String(sp.createdAt)
            : '2025-01-01T00:00:00.000Z',
        };
      });

      return [personalWs, ...mappedUnified];
    }

    return [personalWs, ...workspaces.filter((w) => w.id !== personalWorkspaceId)];
  }, [unifiedSpaces, workspaces, sharedUser.email, sharedUser.uid, sharedUser.name, personalWorkspaceId]);

  const [lists, setLists] = useState<AcquisitionList[]>(() => {
    const saved = localStorage.getItem(lsListsKey);
    if (saved) return JSON.parse(saved);
    if (sharedUser.isDemo) {
      return INITIAL_LISTS.map((l) => ({
        ...l,
        workspaceId: personalWorkspaceId,
        scopeType: 'individual' as const,
        ownerUid: sharedUser.uid,
      }));
    }
    return [];
  });

  const [items, setItems] = useState<AcquisitionItem[]>(() => {
    const saved = localStorage.getItem(lsItemsKey);
    if (saved) return JSON.parse(saved);
    if (sharedUser.isDemo) {
      return INITIAL_ITEMS.map((i) => ({
        ...i,
        workspaceId: personalWorkspaceId,
        createdByUid: sharedUser.uid,
      }));
    }
    return [];
  });

  const [taxonomyGroups, setTaxonomyGroups] = useState<TaxonomyGroup[]>(() => {
    const saved = localStorage.getItem(lsTaxKey) || localStorage.getItem('app_aquisicoes_taxonomy');
    return saved ? JSON.parse(saved) : INITIAL_TAXONOMY_GROUPS;
  });

  const [syncError, setSyncError] = useState<string | null>(null);
  const [isLoadingLists, setIsLoadingLists] = useState<boolean>(false);
  const listsRef = useRef<AcquisitionList[]>(lists);
  const itemsRef = useRef<AcquisitionItem[]>(items);

  useEffect(() => {
    listsRef.current = lists;
  }, [lists]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Reload user-scoped state when sharedUser.uid changes
  useEffect(() => {
    const savedLists = localStorage.getItem(lsListsKey);
    const savedItems = localStorage.getItem(lsItemsKey);
    const savedTax = localStorage.getItem(lsTaxKey);
    if (savedLists) {
      setLists(JSON.parse(savedLists));
    } else if (sharedUser.isDemo) {
      setLists(
        INITIAL_LISTS.map((l) => ({
          ...l,
          workspaceId: personalWorkspaceId,
          scopeType: 'individual' as const,
          ownerUid: sharedUser.uid,
        }))
      );
    } else {
      setLists([]);
    }
    if (savedItems) {
      setItems(JSON.parse(savedItems));
    } else if (sharedUser.isDemo) {
      setItems(
        INITIAL_ITEMS.map((i) => ({
          ...i,
          workspaceId: personalWorkspaceId,
          createdByUid: sharedUser.uid,
        }))
      );
    } else {
      setItems([]);
    }
    if (savedTax) {
      setTaxonomyGroups(JSON.parse(savedTax));
    }
  }, [sharedUser.uid, sharedUser.isDemo, personalWorkspaceId, lsListsKey, lsItemsKey, lsTaxKey]);

  const sharedSpaceIds = useMemo(
    () =>
      effectiveWorkspaces
        .filter((w) => w.id !== personalWorkspaceId)
        .map((w) => w.id),
    [effectiveWorkspaces, personalWorkspaceId]
  );
  const sharedSpaceIdsKey = sharedSpaceIds.join('|');

  // Real-time onSnapshot subscriptions for individual & shared lists + items
  useEffect(() => {
    if (sharedUser.isDemo || !sharedUser.uid || sharedUser.uid === 'usr_anonymous') {
      setIsLoadingLists(false);
      return;
    }

    let disposed = false;
    setIsLoadingLists(true);
    setSyncError(null);

    let indLists: AcquisitionList[] = [];
    const sharedListsBySpace = new Map<string, AcquisitionList[]>();
    const itemUnsubs = new Map<string, () => void>();
    const itemsByList = new Map<string, AcquisitionItem[]>();
    const listWorkspaceMap = new Map<string, string>();

    const emitMergedItems = () => {
      if (disposed) return;
      const mergedItems: AcquisitionItem[] = [];
      itemsByList.forEach((listItems) => {
        mergedItems.push(...listItems);
      });
      mergedItems.sort((a, b) => {
        const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return tb - ta;
      });
      setItems(mergedItems);
    };

    const syncListsAndItemListeners = () => {
      if (disposed) return;

      const mergedMap = new Map<string, AcquisitionList>();
      indLists.forEach((l) => {
        const normalized: AcquisitionList = {
          ...l,
          workspaceId: personalWorkspaceId,
          scopeType: 'individual',
        };
        mergedMap.set(normalized.id, normalized);
      });
      sharedListsBySpace.forEach((spaceLists, sid) => {
        spaceLists.forEach((l) => {
          const normalized: AcquisitionList = {
            ...l,
            workspaceId: l.spaceId || l.workspaceId || sid,
            scopeType: 'shared',
          };
          mergedMap.set(normalized.id, normalized);
        });
      });

      const allLists = Array.from(mergedMap.values());
      allLists.forEach((l) => listWorkspaceMap.set(l.id, l.workspaceId));
      setLists(allLists);
      setIsLoadingLists(false);

      const activeIds = new Set(allLists.map((l) => l.id));

      // Remove listeners for archived/deleted/inaccessible lists
      for (const [listId, unsub] of itemUnsubs.entries()) {
        if (!activeIds.has(listId)) {
          unsub();
          itemUnsubs.delete(listId);
          itemsByList.delete(listId);
          listWorkspaceMap.delete(listId);
        }
      }

      // Attach listeners for new lists
      for (const list of allLists) {
        if (!itemUnsubs.has(list.id)) {
          const unsubItems = subscribeToListItems(
            list.id,
            (fetchedItems) => {
              if (disposed) return;
              const parentWsId = listWorkspaceMap.get(list.id) || list.workspaceId;
              const normalizedItems = fetchedItems.map((it) => ({
                ...it,
                listId: it.listId || list.id,
                workspaceId: parentWsId,
              }));
              itemsByList.set(list.id, normalizedItems);
              emitMergedItems();
            },
            (err) => {
              console.warn(`[AcquisitionsModuleView] Erro ao sincronizar itens da lista ${list.id}:`, err);
              if (!disposed) {
                setSyncError('Falha ao sincronizar itens em tempo real com o servidor.');
              }
            }
          );
          itemUnsubs.set(list.id, unsubItems);
        }
      }

      emitMergedItems();
    };

    const unsubListWatchers: Array<() => void> = [];

    unsubListWatchers.push(
      subscribeToIndividualLists(
        sharedUser.uid,
        (fetched) => {
          indLists = fetched;
          syncListsAndItemListeners();
        },
        (err) => {
          console.warn('[AcquisitionsModuleView] Erro ao sincronizar listas individuais:', err);
          if (!disposed) {
            setIsLoadingLists(false);
            setSyncError('Não foi possível sincronizar suas listas individuais.');
          }
        }
      )
    );

    const spaceIdsToWatch = sharedSpaceIdsKey ? sharedSpaceIdsKey.split('|').filter(Boolean) : [];
    for (const sid of spaceIdsToWatch) {
      unsubListWatchers.push(
        subscribeToSharedLists(
          sid,
          (fetched) => {
            sharedListsBySpace.set(sid, fetched);
            syncListsAndItemListeners();
          },
          (err) => {
            console.warn(`[AcquisitionsModuleView] Erro ao sincronizar listas do espaço ${sid}:`, err);
            if (!disposed) {
              setIsLoadingLists(false);
              setSyncError('Não foi possível sincronizar listas compartilhadas.');
            }
          }
        )
      );
    }

    return () => {
      disposed = true;
      unsubListWatchers.forEach((unsub) => unsub());
      itemUnsubs.forEach((unsub) => unsub());
      itemUnsubs.clear();
    };
  }, [sharedUser.uid, sharedUser.isDemo, personalWorkspaceId, sharedSpaceIdsKey]);

  // Navigation State: Default directly to 'workspace_detail' (Kanban das Listas)
  const [activeRoute, setActiveRoute] = useState<ActiveRoute>('workspace_detail');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(() => {
    if (initialWorkspaceIdToOpen) return initialWorkspaceIdToOpen;
    return personalWorkspaceId;
  });

  useEffect(() => {
    if (initialWorkspaceIdToOpen) {
      setSelectedWorkspaceId(initialWorkspaceIdToOpen);
      setActiveRoute('workspace_detail');
      if (onClearInitialWorkspace) {
        onClearInitialWorkspace();
      }
    } else if (
      effectiveWorkspaces.length > 0 &&
      !effectiveWorkspaces.some((w) => w.id === selectedWorkspaceId)
    ) {
      setSelectedWorkspaceId(effectiveWorkspaces[0].id);
    }
  }, [initialWorkspaceIdToOpen, onClearInitialWorkspace, effectiveWorkspaces, selectedWorkspaceId]);

  // Persist changes locally (UID-scoped)
  useEffect(() => {
    localStorage.setItem('app_aquisicoes_user', JSON.stringify(currentUser));
  }, [currentUser]);

  useEffect(() => {
    localStorage.setItem('app_aquisicoes_workspaces', JSON.stringify(workspaces));
  }, [workspaces]);

  useEffect(() => {
    localStorage.setItem(lsListsKey, JSON.stringify(lists));
  }, [lsListsKey, lists]);

  useEffect(() => {
    localStorage.setItem(lsItemsKey, JSON.stringify(items));
  }, [lsItemsKey, items]);

  useEffect(() => {
    localStorage.setItem(lsTaxKey, JSON.stringify(taxonomyGroups));
  }, [lsTaxKey, taxonomyGroups]);

  // Ensure current user is included in initial demo workspace when first opened
  useEffect(() => {
    const normalizedEmail = currentUser.email.toLowerCase();
    setWorkspaces((prev) => {
      const hasAnyAccepted = prev.some((w) =>
        w.acceptedMemberEmails?.some((em) => em.toLowerCase() === normalizedEmail)
      );
      if (hasAnyAccepted) return prev;
      return prev.map((w, idx) => {
        if (idx !== 0) return w;
        return {
          ...w,
          acceptedMemberEmails: Array.from(
            new Set([...(w.acceptedMemberEmails || []), normalizedEmail])
          ),
          acceptedMemberUids: Array.from(
            new Set([...(w.acceptedMemberUids || []), currentUser.uid])
          ),
          members: [
            ...w.members,
            {
              uid: currentUser.uid,
              email: normalizedEmail,
              name: currentUser.displayName,
              role: 'Admin' as const,
              status: 'Aceito' as const,
              respondedAt: new Date().toISOString(),
            },
          ],
        };
      });
    });
  }, [currentUser.email, currentUser.uid, currentUser.displayName]);

  useEffect(() => {
    fetchAcceptedWorkspacesFromFirestore(currentUser.email)
      .then((remoteWorkspaces) => {
        if (remoteWorkspaces && remoteWorkspaces.length > 0) {
          setWorkspaces((prev) => {
            const byId = new Map(prev.map((w) => [w.id, w]));
            remoteWorkspaces.forEach((rw) => byId.set(rw.id, rw));
            return Array.from(byId.values());
          });
        }
      })
      .catch(() => {
        // Offline / external console rules fallback
      });
  }, [currentUser.email]);

  // =========================================================================
  // USER PROFILE & WORKSPACE HANDLERS
  // =========================================================================
  const handleUserChange = (newProfile: UserProfile) => {
    setCurrentUser(newProfile);
    const targetEmail = newProfile.email.toLowerCase();
    setWorkspaces((prev) =>
      prev.map((ws) => {
        const hasMember = ws.members.some((m) => m.email.toLowerCase() === targetEmail);
        if (!hasMember) return ws;
        const updatedWs: Workspace = {
          ...ws,
          members: ws.members.map((m) =>
            m.email.toLowerCase() === targetEmail
              ? { ...m, name: newProfile.displayName }
              : m
          ),
        };
        saveWorkspaceToFirestore(updatedWs);
        return updatedWs;
      })
    );
  };

  const handleUpdateUserName = (newName: string) => {
    const cleanName = newName.trim();
    if (!cleanName) return;
    const updatedProfile: UserProfile = {
      ...currentUser,
      displayName: cleanName,
    };
    upsertUserDocument(updatedProfile);
    handleUserChange(updatedProfile);
  };

  const handleSelectWorkspace = (workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
    setActiveRoute('workspace_detail');
  };

  const handleCreateWorkspace = (
    name: string,
    description: string,
    type: 'Individual' | 'Compartilhado',
    budget: number,
    invitedEmails: string[],
    creatorName?: string
  ) => {
    const now = new Date().toISOString();
    const wsId = `ws_${Date.now()}`;
    const ownerEmail = currentUser.email.toLowerCase();
    const ownerName = creatorName?.trim() || currentUser.displayName || ownerEmail.split('@')[0];

    const members = [
      {
        uid: currentUser.uid,
        email: ownerEmail,
        name: ownerName,
        role: 'Admin' as const,
        status: 'Aceito' as const,
        respondedAt: now,
      },
      ...invitedEmails.map((em) => ({
        email: em,
        name: em.split('@')[0],
        role: 'Membro' as const,
        status: 'Pendente' as const,
      })),
    ];

    const newWs: Workspace = {
      id: wsId,
      name,
      description,
      type,
      ownerUid: currentUser.uid,
      ownerEmail,
      acceptedMemberEmails: [ownerEmail],
      acceptedMemberUids: [currentUser.uid],
      members,
      monthlyBudget: budget,
      createdAt: now,
    };

    const defaultLists: AcquisitionList[] = [
      {
        id: `list_rec_${Date.now()}`,
        workspaceId: wsId,
        name: 'Lista Recorrente Principal',
        type: 'recorrente',
        description: 'Controle de estoque mínimo e reposição.',
        acceptedMemberEmails: [ownerEmail],
        createdAt: now,
      },
      {
        id: `list_obj_${Date.now() + 1}`,
        workspaceId: wsId,
        name: 'Objetivos Financeiros',
        type: 'objetivo',
        description: 'Metas de poupança e cotações.',
        acceptedMemberEmails: [ownerEmail],
        createdAt: now,
      },
      {
        id: `list_des_${Date.now() + 2}`,
        workspaceId: wsId,
        name: 'Lista de Desejos',
        type: 'desejo',
        description: 'Ideias e avaliações de compra.',
        acceptedMemberEmails: [ownerEmail],
        createdAt: now,
      },
    ];

    setWorkspaces((prev) => [newWs, ...prev]);
    setLists((prev) => [...defaultLists, ...prev]);
    saveWorkspaceToFirestore(newWs);
    defaultLists.forEach((l) => saveListToFirestore(l));
  };

  const handleUpdateWorkspace = (
    workspaceId: string,
    name: string,
    description: string,
    type: 'Individual' | 'Compartilhado',
    budget: number
  ) => {
    setWorkspaces((prev) =>
      prev.map((ws) => {
        if (ws.id !== workspaceId) return ws;
        const updatedWs: Workspace = {
          ...ws,
          name,
          description,
          type,
          monthlyBudget: budget,
        };
        saveWorkspaceToFirestore(updatedWs);
        return updatedWs;
      })
    );
  };

  const handleDeleteWorkspace = (workspaceId: string) => {
    setWorkspaces((prev) => prev.filter((ws) => ws.id !== workspaceId));
    setLists((prev) => prev.filter((l) => l.workspaceId !== workspaceId));
    setItems((prev) => prev.filter((i) => i.workspaceId !== workspaceId));
    deleteWorkspaceFromFirestore(workspaceId);
    if (selectedWorkspaceId === workspaceId) {
      setActiveRoute('workspaces');
    }
  };

  const handleAcceptInvitation = (workspaceId: string) => {
    const userEmail = currentUser.email.toLowerCase();
    const now = new Date().toISOString();

    setWorkspaces((prev) =>
      prev.map((ws) => {
        if (ws.id !== workspaceId) return ws;
        const updatedMembers = ws.members.map((m) =>
          m.email.toLowerCase() === userEmail
            ? { ...m, uid: currentUser.uid, status: 'Aceito' as const, respondedAt: now }
            : m
        );
        const acceptedEmails = Array.from(
          new Set([...ws.acceptedMemberEmails, userEmail])
        );
        const acceptedUids = Array.from(
          new Set([...(ws.acceptedMemberUids || []), currentUser.uid])
        );
        const updatedWs: Workspace = {
          ...ws,
          members: updatedMembers,
          acceptedMemberEmails: acceptedEmails,
          acceptedMemberUids: acceptedUids,
        };
        saveWorkspaceToFirestore(updatedWs);
        return updatedWs;
      })
    );
  };

  const handleRejectInvitation = (
    workspaceId: string,
    reason: string,
    note: string
  ) => {
    const userEmail = currentUser.email.toLowerCase();
    const now = new Date().toISOString();

    setWorkspaces((prev) =>
      prev.map((ws) => {
        if (ws.id !== workspaceId) return ws;
        const updatedMembers = ws.members.map((m) =>
          m.email.toLowerCase() === userEmail
            ? {
                ...m,
                status: 'Recusado' as const,
                rejectionReason: reason,
                rejectionNote: note,
                respondedAt: now,
              }
            : m
        );
        const updatedWs: Workspace = {
          ...ws,
          members: updatedMembers,
        };
        saveWorkspaceToFirestore(updatedWs);
        return updatedWs;
      })
    );
  };

  const handleInviteMembersToWorkspace = (
    workspaceId: string,
    emails: string[]
  ) => {
    setWorkspaces((prev) =>
      prev.map((ws) => {
        if (ws.id !== workspaceId) return ws;
        const existingEmails = new Set(
          ws.members.map((m) => m.email.toLowerCase())
        );
        const newMembers = emails
          .filter((em) => !existingEmails.has(em.toLowerCase()))
          .map((em) => ({
            email: em.toLowerCase(),
            name: em.split('@')[0],
            role: 'Membro' as const,
            status: 'Pendente' as const,
          }));
        const updatedWs: Workspace = {
          ...ws,
          members: [...ws.members, ...newMembers],
        };
        saveWorkspaceToFirestore(updatedWs);
        return updatedWs;
      })
    );
  };

  const handleUpdateMemberStatus = (
    workspaceId: string,
    email: string,
    status: 'Pendente' | 'Aceito' | 'Recusado'
  ) => {
    const targetEmail = email.toLowerCase();
    setWorkspaces((prev) =>
      prev.map((ws) => {
        if (ws.id !== workspaceId) return ws;
        const updatedMembers = ws.members.map((m) =>
          m.email.toLowerCase() === targetEmail ? { ...m, status } : m
        );
        const acceptedEmails = updatedMembers
          .filter((m) => m.status === 'Aceito')
          .map((m) => m.email.toLowerCase());

        const updatedWs: Workspace = {
          ...ws,
          members: updatedMembers,
          acceptedMemberEmails: acceptedEmails,
        };
        saveWorkspaceToFirestore(updatedWs);
        return updatedWs;
      })
    );
  };

  const handleRemoveMember = (workspaceId: string, email: string) => {
    const targetEmail = email.toLowerCase();
    setWorkspaces((prev) =>
      prev.map((ws) => {
        if (ws.id !== workspaceId) return ws;
        const updatedMembers = ws.members.filter(
          (m) => m.email.toLowerCase() !== targetEmail
        );
        const acceptedEmails = updatedMembers
          .filter((m) => m.status === 'Aceito')
          .map((m) => m.email.toLowerCase());

        const updatedWs: Workspace = {
          ...ws,
          members: updatedMembers,
          acceptedMemberEmails: acceptedEmails,
        };
        saveWorkspaceToFirestore(updatedWs);
        return updatedWs;
      })
    );
  };

  // =========================================================================
  // LIST & ITEM STATE MACHINE HANDLERS (CREATE, EDIT, DELETE)
  // =========================================================================
  const reportSyncError = (actionLabel: string, err: unknown) => {
    const msg =
      err instanceof Error && err.message
        ? err.message
        : 'Erro inesperado ao sincronizar com o banco de dados.';
    console.error(`[AcquisitionsModuleView] ${actionLabel}:`, err);
    setSyncError(`${actionLabel}: ${msg}`);
  };

  const handleCreateList = async (
    workspaceId: string,
    name: string,
    type: ListType,
    description: string
  ) => {
    const ws = effectiveWorkspaces.find((w) => w.id === workspaceId);
    const isIndividual = workspaceId === personalWorkspaceId;
    const newList: AcquisitionList = {
      id: `list_${type}_${Date.now()}`,
      workspaceId,
      name,
      type,
      description,
      scopeType: isIndividual ? 'individual' : 'shared',
      spaceId: isIndividual ? null : workspaceId,
      ownerUid: sharedUser.uid,
      acceptedMemberEmails: ws?.acceptedMemberEmails || [currentUser.email],
      createdAt: new Date().toISOString(),
    };
    const prevLists = listsRef.current;
    setSyncError(null);
    setLists((prev) => [...prev, newList]);
    if (!sharedUser.isDemo) {
      try {
        await saveListToFirestore(newList);
      } catch (err) {
        setLists(prevLists);
        reportSyncError('Não foi possível criar a lista', err);
      }
    }
  };

  const handleUpdateList = async (
    listId: string,
    name: string,
    type: ListType,
    description: string
  ) => {
    const prevLists = listsRef.current;
    const prevItems = itemsRef.current;
    const existingList = prevLists.find((l) => l.id === listId);
    if (!existingList) return;

    const updatedList: AcquisitionList = {
      ...existingList,
      name,
      type,
      description,
    };

    const defaultStage = getStagesForListType(type)[0].id as ItemStage;
    const itemsToUpdate = prevItems
      .filter((item) => item.listId === listId && item.listType !== type)
      .map((item) => ({
        ...item,
        listType: type,
        stage: defaultStage,
        createdByUid: item.createdByUid || sharedUser.uid,
        updatedAt: new Date().toISOString(),
      }));

    setSyncError(null);
    setLists((prev) => prev.map((l) => (l.id === listId ? updatedList : l)));
    if (itemsToUpdate.length > 0) {
      const byId = new Map(itemsToUpdate.map((i) => [i.id, i]));
      setItems((prev) => prev.map((i) => byId.get(i.id) || i));
    }

    if (!sharedUser.isDemo) {
      try {
        await saveListToFirestore(updatedList);
        if (itemsToUpdate.length > 0) {
          await Promise.all(itemsToUpdate.map((it) => saveItemToFirestore(it)));
        }
      } catch (err) {
        setLists(prevLists);
        setItems(prevItems);
        reportSyncError('Não foi possível atualizar a lista', err);
      }
    }
  };

  const handleDeleteList = async (listId: string) => {
    const prevLists = listsRef.current;
    const prevItems = itemsRef.current;
    setSyncError(null);
    setLists((prev) => prev.filter((l) => l.id !== listId));
    setItems((prev) => prev.filter((i) => i.listId !== listId));
    if (!sharedUser.isDemo) {
      try {
        await deleteListFromFirestore(listId);
      } catch (err) {
        setLists(prevLists);
        setItems(prevItems);
        reportSyncError('Não foi possível excluir a lista', err);
      }
    }
  };

  const handleCreateItem = async (
    newItemData: Omit<AcquisitionItem, 'id' | 'updatedAt' | 'productsHistory'>
  ) => {
    const prevItems = itemsRef.current;
    const newItem: AcquisitionItem = {
      ...newItemData,
      id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdByUid: newItemData.createdByUid || sharedUser.uid,
      productsHistory: [],
      updatedAt: new Date().toISOString(),
    };
    setSyncError(null);
    setItems((prev) => [newItem, ...prev]);
    if (!sharedUser.isDemo) {
      try {
        await saveItemToFirestore(newItem);
      } catch (err) {
        setItems(prevItems);
        reportSyncError('Não foi possível salvar o item', err);
      }
    }
  };

  const handleUpdateItem = async (updatedItem: AcquisitionItem) => {
    const prevItems = itemsRef.current;
    const normalizedItem: AcquisitionItem = {
      ...updatedItem,
      createdByUid: updatedItem.createdByUid || sharedUser.uid,
      updatedAt: updatedItem.updatedAt || new Date().toISOString(),
    };
    setSyncError(null);
    setItems((prev) =>
      prev.map((i) => (i.id === normalizedItem.id ? normalizedItem : i))
    );
    if (!sharedUser.isDemo) {
      try {
        await saveItemToFirestore(normalizedItem);
      } catch (err) {
        setItems(prevItems);
        reportSyncError('Não foi possível atualizar o item', err);
      }
    }
  };

  const handleDeleteItem = async (itemId: string) => {
    const prevItems = itemsRef.current;
    const itemToDelete = prevItems.find((i) => i.id === itemId);
    setSyncError(null);
    setItems((prev) => prev.filter((i) => i.id !== itemId));
    if (!sharedUser.isDemo) {
      try {
        await deleteItemFromFirestore(itemId, itemToDelete?.listId);
      } catch (err) {
        setItems(prevItems);
        reportSyncError('Não foi possível excluir o item', err);
      }
    }
  };

  const handleMoveItemStage = async (item: AcquisitionItem, targetStage: ItemStage) => {
    const prevItems = itemsRef.current;
    const nextItem: AcquisitionItem =
      item.listType === 'recorrente' &&
      item.stage === 'conferido' &&
      targetStage === 'carrinho'
        ? {
            ...revertConfirmedCheckout(item),
            createdByUid: item.createdByUid || sharedUser.uid,
          }
        : {
            ...item,
            stage: targetStage,
            createdByUid: item.createdByUid || sharedUser.uid,
            updatedAt: new Date().toISOString(),
          };

    setSyncError(null);
    setItems((prev) => prev.map((i) => (i.id === item.id ? nextItem : i)));
    if (!sharedUser.isDemo) {
      try {
        await saveItemToFirestore(nextItem);
      } catch (err) {
        setItems(prevItems);
        reportSyncError('Não foi possível mover o item de etapa', err);
      }
    }
  };

  const handleConfirmCartCheckout = async (
    item: AcquisitionItem,
    productInput: {
      brand: string;
      unitPrice: number;
      quantity: number;
      storeName: string;
      receiptUrl?: string;
    },
    advanceToConfirmed: boolean
  ) => {
    const prevItems = itemsRef.current;
    setSyncError(null);

    if (advanceToConfirmed) {
      const unitPriceCents = Math.round(productInput.unitPrice * 100);
      const totalPaidCents = unitPriceCents * (productInput.quantity || 1);
      const { updatedItem: confirmedItem, newProduct } = confirmCartCheckout(
        item,
        productInput
      );
      const updatedItem: AcquisitionItem = {
        ...confirmedItem,
        createdByUid: item.createdByUid || sharedUser.uid,
      };
      setItems((prev) => prev.map((i) => (i.id === item.id ? updatedItem : i)));

      if (!sharedUser.isDemo) {
        try {
          await saveItemToFirestore(updatedItem);
          await recordProductInSubcollection(updatedItem, newProduct);
        } catch (err) {
          setItems(prevItems);
          reportSyncError('Não foi possível confirmar a compra do item', err);
          return;
        }
      }

      try {
        await recordAcquisitionPurchase(
          sharedUser.uid,
          {
            listId: item.listId,
            itemId: item.id,
            storeName: productInput.storeName || 'Loja',
            brand: productInput.brand,
            quantity: productInput.quantity || 1,
            unitPriceCents,
            totalPaidCents,
            receiptUrl: productInput.receiptUrl,
            disbursements: [
              {
                funderUid: sharedUser.uid,
                funderName: sharedUser.name || 'Titular',
                disbursedAmountCents: totalPaidCents,
                fundingSource: 'checking',
              },
            ],
          },
          sharedUser.isDemo
        );
      } catch (err) {
        console.warn('[Acquisitions] Erro ao registrar compra no serviço canônico:', err);
      }
    } else {
      const updatedItem: AcquisitionItem = {
        ...item,
        stage: 'carrinho',
        createdByUid: item.createdByUid || sharedUser.uid,
        cartDraft: {
          brand: productInput.brand,
          unitPrice: productInput.unitPrice,
          quantity: productInput.quantity,
          storeName: productInput.storeName,
          receiptUrl: productInput.receiptUrl,
        },
        updatedAt: new Date().toISOString(),
      };
      setItems((prev) => prev.map((i) => (i.id === item.id ? updatedItem : i)));
      if (!sharedUser.isDemo) {
        try {
          await saveItemToFirestore(updatedItem);
        } catch (err) {
          setItems(prevItems);
          reportSyncError('Não foi possível salvar o produto no carrinho', err);
        }
      }
    }
  };

  const handleAddGoalDeposit = async (
    item: AcquisitionItem,
    amount: number,
    note: string
  ) => {
    const prevItems = itemsRef.current;
    setSyncError(null);
    const updated: AcquisitionItem = {
      ...addGoalDeposit(item, amount, currentUser.email, note),
      createdByUid: item.createdByUid || sharedUser.uid,
    };
    setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    if (!sharedUser.isDemo) {
      try {
        await saveItemToFirestore(updated);
      } catch (err) {
        setItems(prevItems);
        reportSyncError('Não foi possível salvar o depósito da meta', err);
        return;
      }
    }
    try {
      await recordAcquisitionDeposit(
        sharedUser.uid,
        {
          listId: item.listId,
          itemId: item.id,
          amountCents: Math.round(amount * 100),
          depositDate: new Date().toISOString().slice(0, 10),
          notes: note,
        },
        sharedUser.isDemo
      );
    } catch (err) {
      console.warn('[Acquisitions] Erro ao registrar aporte no serviço canônico:', err);
    }
  };

  const handleAddGoalQuote = async (
    item: AcquisitionItem,
    quoteInput: Omit<GoalQuote, 'id' | 'recordedAt'>
  ) => {
    const prevItems = itemsRef.current;
    setSyncError(null);
    const newQuote: GoalQuote = {
      ...quoteInput,
      id: `quote_${Date.now()}`,
      recordedAt: new Date().toISOString(),
    };
    const updated: AcquisitionItem = {
      ...item,
      createdByUid: item.createdByUid || sharedUser.uid,
      quotes: [newQuote, ...(item.quotes || [])],
      updatedAt: new Date().toISOString(),
    };
    setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    if (!sharedUser.isDemo) {
      try {
        await saveItemToFirestore(updated);
      } catch (err) {
        setItems(prevItems);
        reportSyncError('Não foi possível salvar a cotação', err);
        return;
      }
    }
    try {
      await recordAcquisitionQuote(
        sharedUser.uid,
        {
          listId: item.listId,
          itemId: item.id,
          storeName: quoteInput.storeName,
          priceCents: Math.round(quoteInput.price * 100),
          url: quoteInput.url,
          validUntil: (quoteInput as any).validUntil,
        },
        sharedUser.isDemo
      );
    } catch (err) {
      console.warn('[Acquisitions] Erro ao registrar cotação no serviço canônico:', err);
    }
  };

  const handleDeleteGoalQuote = async (item: AcquisitionItem, quoteId: string) => {
    const prevItems = itemsRef.current;
    setSyncError(null);
    const updated: AcquisitionItem = {
      ...item,
      createdByUid: item.createdByUid || sharedUser.uid,
      quotes: (item.quotes || []).filter((q) => q.id !== quoteId),
      updatedAt: new Date().toISOString(),
    };
    setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    if (!sharedUser.isDemo) {
      try {
        await saveItemToFirestore(updated);
      } catch (err) {
        setItems(prevItems);
        reportSyncError('Não foi possível remover a cotação', err);
      }
    }
  };

  const handleCompleteGoalAcquisition = async (
    item: AcquisitionItem,
    finalPaidAmount: number,
    storeName: string,
    brand: string
  ) => {
    const prevItems = itemsRef.current;
    setSyncError(null);
    const now = new Date().toISOString();
    const newProd = {
      id: `prod_goal_${Date.now()}`,
      itemId: item.id,
      brand,
      unitPrice: finalPaidAmount,
      quantity: 1,
      totalPrice: finalPaidAmount,
      storeName,
      purchaseDate: now,
    };
    const updated: AcquisitionItem = {
      ...item,
      createdByUid: item.createdByUid || sharedUser.uid,
      stage: 'adquirido',
      finalPaidAmount,
      acquiredStore: storeName,
      acquiredDate: now,
      productsHistory: [newProd, ...(item.productsHistory || [])],
      updatedAt: now,
    };
    setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    if (!sharedUser.isDemo) {
      try {
        await saveItemToFirestore(updated);
        await recordProductInSubcollection(updated, newProd);
      } catch (err) {
        setItems(prevItems);
        reportSyncError('Não foi possível concluir a aquisição da meta', err);
      }
    }
  };

  const handleConvertWishToGoal = async (
    wishItem: AcquisitionItem,
    targetGoalListId: string
  ) => {
    const prevItems = itemsRef.current;
    setSyncError(null);
    const { convertedGoalItem: rawGoalItem, updatedWishItem: rawWishItem } =
      convertWishToGoal(wishItem, targetGoalListId);
    const convertedGoalItem: AcquisitionItem = {
      ...rawGoalItem,
      createdByUid: sharedUser.uid,
    };
    const updatedWishItem: AcquisitionItem = {
      ...rawWishItem,
      createdByUid: wishItem.createdByUid || sharedUser.uid,
    };
    setItems((prev) => [
      convertedGoalItem,
      ...prev.map((i) => (i.id === wishItem.id ? updatedWishItem : i)),
    ]);
    if (!sharedUser.isDemo) {
      try {
        await Promise.all([
          saveItemToFirestore(convertedGoalItem),
          saveItemToFirestore(updatedWishItem),
        ]);
      } catch (err) {
        setItems(prevItems);
        reportSyncError('Não foi possível converter o desejo em objetivo', err);
      }
    }
  };

  const handleAdjustItemStock = async (
    item: AcquisitionItem,
    delta: number,
    autoMoveToBuyOnCritical: boolean
  ) => {
    const prevItems = itemsRef.current;
    setSyncError(null);
    const updated: AcquisitionItem = {
      ...adjustItemStock(item, delta, autoMoveToBuyOnCritical),
      createdByUid: item.createdByUid || sharedUser.uid,
    };
    setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    if (!sharedUser.isDemo) {
      try {
        await saveItemToFirestore(updated);
      } catch (err) {
        setItems(prevItems);
        reportSyncError('Não foi possível atualizar o estoque do item', err);
        return;
      }
    }
    try {
      if (delta !== 0) {
        await recordStockMovement(
          sharedUser.uid,
          {
            listId: item.listId,
            itemId: item.id,
            movementType: delta > 0 ? 'purchase_inflow' : 'consumption_outflow',
            quantityDelta: delta,
            justification: 'Ajuste manual de estoque',
          },
          sharedUser.isDemo
        );
      }
    } catch (err) {
      console.warn('[Acquisitions] Erro ao registrar movimentação de estoque:', err);
    }
  };

  const handleReturnConfirmedToStock = async (item: AcquisitionItem) => {
    const prevItems = itemsRef.current;
    setSyncError(null);
    const updated: AcquisitionItem = {
      ...returnConfirmedToStock(item),
      createdByUid: item.createdByUid || sharedUser.uid,
    };
    setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    if (!sharedUser.isDemo) {
      try {
        await saveItemToFirestore(updated);
      } catch (err) {
        setItems(prevItems);
        reportSyncError('Não foi possível retornar o item para a despensa', err);
        return;
      }
    }
    try {
      const lastProduct = item.productsHistory?.[0];
      const purchaseId = lastProduct?.id || `pur_${item.id}`;
      await reverseAcquisitionPurchase(
        sharedUser.uid,
        {
          listId: item.listId,
          itemId: item.id,
          purchaseId,
          reversalReason: 'Retorno de item confirmado para estoque pelo usuário',
        },
        sharedUser.isDemo
      );
    } catch (err) {
      console.warn('[Acquisitions] Erro ao registrar estorno de compra no serviço canônico:', err);
    }
  };

  // =========================================================================
  // GLOBAL TAXONOMY HANDLERS (CREATE, EDIT, DELETE)
  // =========================================================================
  const handleAddTaxonomyGroup = (
    name: string,
    code: string,
    description: string
  ) => {
    const newGrp: TaxonomyGroup = {
      id: `grp_${Date.now()}`,
      name,
      code,
      description,
      categories: [],
    };
    setTaxonomyGroups((prev) => [...prev, newGrp]);
    saveTaxonomyGroupToFirestore(newGrp);
  };

  const handleUpdateTaxonomyGroup = (
    groupId: string,
    name: string,
    code: string,
    description: string
  ) => {
    setTaxonomyGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        const updated = { ...g, name, code, description };
        saveTaxonomyGroupToFirestore(updated);
        return updated;
      })
    );
  };

  const handleDeleteTaxonomyGroup = (groupId: string) => {
    setTaxonomyGroups((prev) => prev.filter((g) => g.id !== groupId));
    deleteTaxonomyGroupFromFirestore(groupId);
  };

  const handleSwitchToAdmin = () => {
    const adminProfile: UserProfile = {
      uid: ADMIN_USER_UID,
      email: currentUser.email || 'kenielcalixtonkenny@gmail.com',
      displayName: currentUser.displayName || 'Keniel Calixto',
      isAdmin: true,
    };
    upsertUserDocument(adminProfile);
    handleUserChange(adminProfile);
    setActiveRoute('admin');
  };

  const handleAddTaxonomyCategory = (groupId: string, categoryName: string) => {
    setTaxonomyGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        const newCat = {
          id: `cat_${Date.now()}`,
          groupId,
          name: categoryName,
        };
        const updated = { ...g, categories: [...g.categories, newCat] };
        saveTaxonomyGroupToFirestore(updated);
        return updated;
      })
    );
  };

  const handleUpdateTaxonomyCategory = (
    groupId: string,
    categoryId: string,
    categoryName: string
  ) => {
    setTaxonomyGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        const updated = {
          ...g,
          categories: g.categories.map((c) =>
            c.id === categoryId ? { ...c, name: categoryName } : c
          ),
        };
        saveTaxonomyGroupToFirestore(updated);
        return updated;
      })
    );
  };

  const handleDeleteTaxonomyCategory = (groupId: string, categoryId: string) => {
    setTaxonomyGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        const updated = {
          ...g,
          categories: g.categories.filter((c) => c.id !== categoryId),
        };
        saveTaxonomyGroupToFirestore(updated);
        return updated;
      })
    );
  };

  const activeWorkspace =
    effectiveWorkspaces.find((w) => w.id === selectedWorkspaceId) ||
    effectiveWorkspaces[0];

  const isAdminUser =
    isAcquisitionAdminUid(currentUser.uid) || Boolean(currentUser.isAdmin);

  return (
    <div className="space-y-4">
      {syncError && (
        <div
          role="alert"
          className="bg-rose-950/70 border border-rose-500/40 rounded-xl px-4 py-3 flex items-center justify-between gap-3 text-xs text-rose-200"
        >
          <div className="flex items-center gap-2">
            <i className="ph-bold ph-warning-circle text-rose-400 text-base shrink-0"></i>
            <span>{syncError}</span>
          </div>
          <button
            type="button"
            onClick={() => setSyncError(null)}
            className="px-2.5 py-1 rounded-lg bg-rose-900/60 hover:bg-rose-800/80 text-rose-100 font-semibold shrink-0 cursor-pointer"
          >
            Fechar
          </button>
        </div>
      )}
      {isLoadingLists && !sharedUser.isDemo && (
        <div className="bg-slate-800/70 border border-slate-700/70 rounded-xl px-3.5 py-2 text-xs text-slate-300 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
          <span>Sincronizando listas e itens em tempo real...</span>
        </div>
      )}
      {effectiveWorkspaces.length === 0 ? (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-8 text-center space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center mx-auto">
            <FolderKanban className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">Nenhum Espaço de Listas Encontrado</h3>
            <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
              Crie um novo espaço para gerenciar listas de compras, controle de despensa e metas financeiras.
            </p>
          </div>
          {onOpenCreateSpace && (
            <button
              type="button"
              onClick={() => onOpenCreateSpace('acquisitions')}
              className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs inline-flex items-center gap-2 cursor-pointer shadow-md shadow-amber-500/20"
            >
              <i className="ph-bold ph-plus"></i>
              <span>+ Criar Primeiro Espaço de Listas</span>
            </button>
          )}
        </div>
      ) : activeWorkspace ? (
        <div className="space-y-4">
          {/* Seletor Integrado de Espaços Unificados para o Quadro de Listas */}
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-3 sm:px-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
                  <FolderKanban className="w-3.5 h-3.5" />
                </div>
                <span className="text-xs font-bold text-slate-300">
                  Espaço Ativo:
                </span>
              </div>

              <select
                value={activeWorkspace.id}
                onChange={(e) => setSelectedWorkspaceId(e.target.value)}
                className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-1.5 text-xs font-bold text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
              >
                {effectiveWorkspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.id === personalWorkspaceId ? 'Individual' : 'Compartilhado'} · {ws.name} {ws.monthlyBudget ? `— Teto: ${formatCurrencyBRL(ws.monthlyBudget)}` : ''}
                  </option>
                ))}
              </select>

              {activeWorkspace.monthlyBudget && activeWorkspace.monthlyBudget > 0 ? (
                <span className="px-2.5 py-1 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-mono font-bold">
                  Orçamento: {formatCurrencyBRL(activeWorkspace.monthlyBudget)}
                </span>
              ) : null}
            </div>

            <div className="flex items-center gap-2 self-start sm:self-auto">
              {onOpenCreateSpace && (
                <button
                  type="button"
                  onClick={() => onOpenCreateSpace('acquisitions')}
                  className="px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 cursor-pointer shadow-md shadow-amber-500/20"
                  title="Criar um novo espaço exclusivo para listas de compras"
                >
                  <i className="ph-bold ph-plus"></i>
                  <span>+ Novo Espaço de Listas</span>
                </button>
              )}

              {onOpenManageSpaces && (
                <button
                  type="button"
                  onClick={onOpenManageSpaces}
                  className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-slate-300 hover:text-white flex items-center gap-1.5 cursor-pointer"
                >
                  <i className="ph-bold ph-pencil-simple text-amber-400"></i>
                  <span>Gerenciar Espaços</span>
                </button>
              )}
            </div>
          </div>

          <WorkspaceBoardView
            workspace={activeWorkspace}
            lists={lists}
            items={items}
            taxonomyGroups={taxonomyGroups}
            currentUser={currentUser}
            openCreateListTrigger={openCreateListTrigger}
            onBackToHub={() => {
              // Permanece no quadro de listas
            }}
            onUpdateWorkspace={handleUpdateWorkspace}
            onDeleteWorkspace={handleDeleteWorkspace}
            onInviteMembers={handleInviteMembersToWorkspace}
            onUpdateMemberStatus={handleUpdateMemberStatus}
            onRemoveMember={handleRemoveMember}
            onCreateList={handleCreateList}
            onUpdateList={handleUpdateList}
            onDeleteList={handleDeleteList}
            onCreateItem={handleCreateItem}
            onUpdateItem={handleUpdateItem}
            onDeleteItem={handleDeleteItem}
            onMoveItemStage={handleMoveItemStage}
            onConfirmCartCheckout={handleConfirmCartCheckout}
            onAddGoalDeposit={handleAddGoalDeposit}
            onAddGoalQuote={handleAddGoalQuote}
            onDeleteGoalQuote={handleDeleteGoalQuote}
            onCompleteGoalAcquisition={handleCompleteGoalAcquisition}
            onConvertWishToGoal={handleConvertWishToGoal}
            onAdjustItemStock={handleAdjustItemStock}
            onReturnConfirmedToStock={handleReturnConfirmedToStock}
            onCreateExpenseFromPurchase={onCreateExpenseFromPurchase}
          />
        </div>
      ) : null}
    </div>
  );
};
