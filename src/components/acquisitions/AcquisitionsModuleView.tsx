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
import {
  addGoalDeposit,
  adjustItemStock,
  confirmCartCheckout,
  convertWishToGoal,
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
    return saved ? JSON.parse(saved) : INITIAL_WORKSPACES;
  });

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

  // Navigation State: Default to 'dashboard' (with alerts & invitations)
  const [activeRoute, setActiveRoute] = useState<ActiveRoute>('dashboard');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('ws_residencia');

  useEffect(() => {
    if (initialWorkspaceIdToOpen) {
      setSelectedWorkspaceId(initialWorkspaceIdToOpen);
      setActiveRoute('workspace_detail');
      if (onClearInitialWorkspace) {
        onClearInitialWorkspace();
      }
    }
  }, [initialWorkspaceIdToOpen, onClearInitialWorkspace]);

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
    workspaces.find((w) => w.id === selectedWorkspaceId) || workspaces[0];

  const isAdminUser =
    isAcquisitionAdminUid(currentUser.uid) || Boolean(currentUser.isAdmin);

  return (
    <div className="space-y-6">
      {/* Sub-navegação interna do Módulo de Aquisições */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-3 sm:px-5 sm:py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
            <FolderKanban className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white leading-tight">
              Módulo de Listas & Aquisições
            </h2>
            <p className="text-[11px] text-slate-400">
              Controle de despensa recorrente, metas de compra e lista de desejos
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 bg-slate-900/90 border border-slate-700/80 p-1 rounded-xl">
          <button
            type="button"
            onClick={() => setActiveRoute('dashboard')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
              activeRoute === 'dashboard'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
            }`}
          >
            <LayoutDashboard className="w-3.5 h-3.5" />
            <span>Visão Geral</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveRoute('workspaces')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
              activeRoute === 'workspaces' || activeRoute === 'workspace_detail'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
            }`}
          >
            <FolderKanban className="w-3.5 h-3.5" />
            <span>Espaços & Listas</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveRoute('settings')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
              activeRoute === 'settings'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
            <span>Categorias de Produtos</span>
          </button>
        </div>
      </div>

      {/* Conteúdo Dinâmico do Módulo de Aquisições */}
      <div>
        {activeRoute === 'dashboard' && (
          <DashboardOverviewView
            workspaces={workspaces}
            lists={lists}
            items={items}
            currentUser={currentUser}
            onUpdateUserName={handleUpdateUserName}
            onSelectWorkspace={handleSelectWorkspace}
            onNavigateToWorkspaces={() => setActiveRoute('workspaces')}
            onAcceptInvitation={handleAcceptInvitation}
            onRejectInvitation={handleRejectInvitation}
          />
        )}

        {activeRoute === 'workspaces' && (
          <HubDashboardView
            workspaces={workspaces}
            lists={lists}
            items={items}
            currentUser={currentUser}
            onUpdateUserName={handleUpdateUserName}
            onSelectWorkspace={handleSelectWorkspace}
            onCreateWorkspace={handleCreateWorkspace}
            onUpdateWorkspace={handleUpdateWorkspace}
            onDeleteWorkspace={handleDeleteWorkspace}
          />
        )}

        {activeRoute === 'workspace_detail' && activeWorkspace && (
          <WorkspaceBoardView
            workspace={activeWorkspace}
            lists={lists}
            items={items}
            taxonomyGroups={taxonomyGroups}
            currentUser={currentUser}
            onBackToHub={() => setActiveRoute('workspaces')}
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
        )}

        {activeRoute === 'admin' && isAdminUser && (
          <AdminEnvironmentView
            currentUser={currentUser}
            workspaces={workspaces}
            lists={lists}
            items={items}
            taxonomyGroups={taxonomyGroups}
            onSwitchToAdmin={handleSwitchToAdmin}
            onSelectWorkspace={handleSelectWorkspace}
            onDeleteWorkspace={handleDeleteWorkspace}
            onGrantAdminAccessToWorkspace={handleAcceptInvitation}
            onRemoteWorkspacesLoaded={(remoteWs) => {
              setWorkspaces((prev) => {
                const byId = new Map(prev.map((w) => [w.id, w]));
                remoteWs.forEach((rw) => byId.set(rw.id, rw));
                return Array.from(byId.values());
              });
            }}
          />
        )}

        {activeRoute === 'settings' && (
          <SettingsView
            groups={taxonomyGroups}
            onAddGroup={handleAddTaxonomyGroup}
            onUpdateGroup={handleUpdateTaxonomyGroup}
            onDeleteGroup={handleDeleteTaxonomyGroup}
            onAddCategory={handleAddTaxonomyCategory}
            onUpdateCategory={handleUpdateTaxonomyCategory}
            onDeleteCategory={handleDeleteTaxonomyCategory}
            currentUser={currentUser}
            onUserChange={handleUserChange}
            onLogout={onLogout}
          />
        )}
      </div>
    </div>
  );
};
