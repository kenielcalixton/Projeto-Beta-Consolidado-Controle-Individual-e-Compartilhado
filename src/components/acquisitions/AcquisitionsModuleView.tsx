import React, { useEffect, useState } from 'react';
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
  upsertUserDocument,
} from '../../services/acquisitionsFirebase';
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
  unifiedSpaces,
  onOpenManageSpaces,
  onOpenCreateSpace,
  onCreateExpenseFromPurchase,
}) => {
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

  // Mapeia os Espaços Unificados (definidos no módulo de Finanças) para Espaços de Aquisições
  const effectiveWorkspaces: Workspace[] = React.useMemo(() => {
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
              email: p.email.toLowerCase(),
              name: p.name,
              role: 'Membro' as const,
              status: (p.status === 'active' ? 'Aceito' : 'Pendente') as any,
            })),
        ];

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
          acceptedMemberUids: [sp.ownerId || sharedUser.uid],
          members: membersList,
          monthlyBudget: sp.monthlyBudget,
          createdAt: sp.createdAt
            ? String(sp.createdAt)
            : '2025-01-01T00:00:00.000Z',
        };
      });

      return mappedUnified;
    }

    return workspaces;
  }, [unifiedSpaces, workspaces, sharedUser.email, sharedUser.uid, sharedUser.name]);

  const [lists, setLists] = useState<AcquisitionList[]>(() => {
    const saved = localStorage.getItem('app_aquisicoes_lists');
    return saved ? JSON.parse(saved) : INITIAL_LISTS;
  });

  const [items, setItems] = useState<AcquisitionItem[]>(() => {
    const saved = localStorage.getItem('app_aquisicoes_items');
    return saved ? JSON.parse(saved) : INITIAL_ITEMS;
  });

  const [taxonomyGroups, setTaxonomyGroups] = useState<TaxonomyGroup[]>(() => {
    const saved = localStorage.getItem('app_aquisicoes_taxonomy');
    return saved ? JSON.parse(saved) : INITIAL_TAXONOMY_GROUPS;
  });

  // Navigation State: Default directly to 'workspace_detail' (Kanban das Listas)
  const [activeRoute, setActiveRoute] = useState<ActiveRoute>('workspace_detail');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(() => {
    if (unifiedSpaces && unifiedSpaces.length > 0) {
      const match = unifiedSpaces.find(
        (sp) => !sp.enabledModules || sp.enabledModules.includes('acquisitions')
      );
      if (match) return match.id;
    }
    return 'ws_residencia';
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

  // Persist changes locally
  useEffect(() => {
    localStorage.setItem('app_aquisicoes_user', JSON.stringify(currentUser));
  }, [currentUser]);

  useEffect(() => {
    localStorage.setItem('app_aquisicoes_workspaces', JSON.stringify(workspaces));
  }, [workspaces]);

  useEffect(() => {
    localStorage.setItem('app_aquisicoes_lists', JSON.stringify(lists));
  }, [lists]);

  useEffect(() => {
    localStorage.setItem('app_aquisicoes_items', JSON.stringify(items));
  }, [items]);

  useEffect(() => {
    localStorage.setItem('app_aquisicoes_taxonomy', JSON.stringify(taxonomyGroups));
  }, [taxonomyGroups]);

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
  const handleCreateList = (
    workspaceId: string,
    name: string,
    type: ListType,
    description: string
  ) => {
    const ws = workspaces.find((w) => w.id === workspaceId);
    const newList: AcquisitionList = {
      id: `list_${type}_${Date.now()}`,
      workspaceId,
      name,
      type,
      description,
      acceptedMemberEmails: ws?.acceptedMemberEmails || [currentUser.email],
      createdAt: new Date().toISOString(),
    };
    setLists((prev) => [...prev, newList]);
    saveListToFirestore(newList);
  };

  const handleUpdateList = (
    listId: string,
    name: string,
    type: ListType,
    description: string
  ) => {
    setLists((prev) =>
      prev.map((l) => {
        if (l.id !== listId) return l;
        const updatedList: AcquisitionList = {
          ...l,
          name,
          type,
          description,
        };
        saveListToFirestore(updatedList);
        return updatedList;
      })
    );

    const defaultStage = getStagesForListType(type)[0].id as ItemStage;
    setItems((prev) =>
      prev.map((item) => {
        if (item.listId !== listId || item.listType === type) return item;
        const updatedItem: AcquisitionItem = {
          ...item,
          listType: type,
          stage: defaultStage,
          updatedAt: new Date().toISOString(),
        };
        saveItemToFirestore(updatedItem);
        return updatedItem;
      })
    );
  };

  const handleDeleteList = (listId: string) => {
    setLists((prev) => prev.filter((l) => l.id !== listId));
    setItems((prev) => prev.filter((i) => i.listId !== listId));
    deleteListFromFirestore(listId);
  };

  const handleCreateItem = (
    newItemData: Omit<AcquisitionItem, 'id' | 'updatedAt' | 'productsHistory'>
  ) => {
    const newItem: AcquisitionItem = {
      ...newItemData,
      id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      productsHistory: [],
      updatedAt: new Date().toISOString(),
    };
    setItems((prev) => [newItem, ...prev]);
    saveItemToFirestore(newItem);
  };

  const handleUpdateItem = (updatedItem: AcquisitionItem) => {
    setItems((prev) =>
      prev.map((i) => (i.id === updatedItem.id ? updatedItem : i))
    );
    saveItemToFirestore(updatedItem);
  };

  const handleDeleteItem = (itemId: string) => {
    setItems((prev) => prev.filter((i) => i.id !== itemId));
    deleteItemFromFirestore(itemId);
  };

  const handleMoveItemStage = (item: AcquisitionItem, targetStage: ItemStage) => {
    if (
      item.listType === 'recorrente' &&
      item.stage === 'conferido' &&
      targetStage === 'carrinho'
    ) {
      const reverted = revertConfirmedCheckout(item);
      setItems((prev) => prev.map((i) => (i.id === item.id ? reverted : i)));
      saveItemToFirestore(reverted);
      return;
    }

    const updated: AcquisitionItem = {
      ...item,
      stage: targetStage,
      updatedAt: new Date().toISOString(),
    };
    setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    saveItemToFirestore(updated);
  };

  const handleConfirmCartCheckout = (
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
    if (advanceToConfirmed) {
      const { updatedItem, newProduct } = confirmCartCheckout(item, productInput);
      setItems((prev) => prev.map((i) => (i.id === item.id ? updatedItem : i)));
      recordProductInSubcollection(updatedItem, newProduct);
    } else {
      const updatedItem: AcquisitionItem = {
        ...item,
        stage: 'carrinho',
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
      saveItemToFirestore(updatedItem);
    }
  };

  const handleAddGoalDeposit = (
    item: AcquisitionItem,
    amount: number,
    note: string
  ) => {
    const updated = addGoalDeposit(item, amount, currentUser.email, note);
    setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    saveItemToFirestore(updated);
  };

  const handleAddGoalQuote = (
    item: AcquisitionItem,
    quoteInput: Omit<GoalQuote, 'id' | 'recordedAt'>
  ) => {
    const newQuote: GoalQuote = {
      ...quoteInput,
      id: `quote_${Date.now()}`,
      recordedAt: new Date().toISOString(),
    };
    const updated: AcquisitionItem = {
      ...item,
      quotes: [newQuote, ...(item.quotes || [])],
      updatedAt: new Date().toISOString(),
    };
    setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    saveItemToFirestore(updated);
  };

  const handleDeleteGoalQuote = (item: AcquisitionItem, quoteId: string) => {
    const updated: AcquisitionItem = {
      ...item,
      quotes: (item.quotes || []).filter((q) => q.id !== quoteId),
      updatedAt: new Date().toISOString(),
    };
    setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    saveItemToFirestore(updated);
  };

  const handleCompleteGoalAcquisition = (
    item: AcquisitionItem,
    finalPaidAmount: number,
    storeName: string,
    brand: string
  ) => {
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
      stage: 'adquirido',
      finalPaidAmount,
      acquiredStore: storeName,
      acquiredDate: now,
      productsHistory: [newProd, ...(item.productsHistory || [])],
      updatedAt: now,
    };
    setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    recordProductInSubcollection(updated, newProd);
  };

  const handleConvertWishToGoal = (
    wishItem: AcquisitionItem,
    targetGoalListId: string
  ) => {
    const { convertedGoalItem, updatedWishItem } = convertWishToGoal(
      wishItem,
      targetGoalListId
    );
    setItems((prev) => [
      convertedGoalItem,
      ...prev.map((i) => (i.id === wishItem.id ? updatedWishItem : i)),
    ]);
    saveItemToFirestore(convertedGoalItem);
    saveItemToFirestore(updatedWishItem);
  };

  const handleAdjustItemStock = (
    item: AcquisitionItem,
    delta: number,
    autoMoveToBuyOnCritical: boolean
  ) => {
    const updated = adjustItemStock(item, delta, autoMoveToBuyOnCritical);
    setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    saveItemToFirestore(updated);
  };

  const handleReturnConfirmedToStock = (item: AcquisitionItem) => {
    const updated = returnConfirmedToStock(item);
    setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    saveItemToFirestore(updated);
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
                    {ws.name} {ws.monthlyBudget ? `— Teto: ${formatCurrencyBRL(ws.monthlyBudget)}` : ''}
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
