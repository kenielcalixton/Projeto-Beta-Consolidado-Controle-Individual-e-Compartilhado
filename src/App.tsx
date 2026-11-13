import React, { useEffect, useMemo, useState } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  auth,
  db,
  FirestoreCloudStatus,
  handleFirestoreError,
  OperationType,
  setFirestoreCloudStatus,
  subscribeToFirestoreCloudStatus,
} from './services/firebase';
import {
  Account,
  ADMIN_UID,
  CascadeMode,
  Category,
  Space,
  Transaction,
  TransactionStatus,
  TransactionType,
  UserProfile,
} from './types/finance';
import { getAdminDemoDataset, getInitialDemoData } from './utils/seedData';
import {
  addMonthsToYearMonth,
  computeAutomatedStatus,
  filterCascadeTargets,
  formatCurrency,
  getTodayDateString,
  isAdminUid,
} from './utils/financeEngine';
import { AuthScreen } from './components/AuthScreen';
import { DashboardView } from './components/DashboardView';
import { AccountsLedgerViewV3 } from './components/accounts/AccountsLedgerViewV3';
import { PersonalFinanceViewV3 } from './components/finance/PersonalFinanceViewV3';
import { SharedSpacesViewV3 } from './components/spaces/SharedSpacesViewV3';
import { PendingDisputesView } from './components/PendingDisputesView';
import { UniversalTransactionModal } from './components/UniversalTransactionModal';
import { AdminDashboardView } from './components/AdminDashboardView';
import { TransactionDetailModal } from './components/TransactionDetailModal';
import { ConfirmSettlementModal } from './components/ConfirmSettlementModal';
import { AcquisitionsModuleView } from './components/acquisitions/AcquisitionsModuleView';
import { SettingsModal, SettingsTab } from './components/SettingsModal';
import { QuickActionFAB } from './components/QuickActionFAB';
import {
  AcquisitionItem,
  AcquisitionList,
  TaxonomyGroup,
} from './types/acquisitions';
import {
  INITIAL_ITEMS,
  INITIAL_LISTS,
  INITIAL_TAXONOMY_GROUPS,
} from './data/acquisitionsSeedData';
import {
  saveTaxonomyGroupToFirestore,
  deleteTaxonomyGroupFromFirestore,
} from './services/acquisitionsFirebase';

type NavTab =
  | 'admin'
  | 'dashboard'
  | 'accounts'
  | 'transactions'
  | 'spaces'
  | 'acquisitions'
  | 'disputes';

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

export function formatMonthYearPt(ym: string): string {
  const [y, m] = ym.split('-');
  return `${MONTH_NAMES_PT[m] || m} ${y}`;
}

// Helpers robustos de persistência local para garantir que lançamentos e dados nunca sumam ao atualizar a página
export const loadLocalMpfData = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

export const saveLocalMpfData = <T,>(key: string, data: T): void => {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.warn(`[LocalCache] Erro ao gravar ${key}:`, e);
  }
};

function AppInner() {
  const { user, isAuthenticated, authReady, logout, enterDemoMode } = useAuth();
  const [profileDisplayName, setProfileDisplayName] = useState<string | null>(null);

  const currentUser = useMemo(() => {
    if (!user) return null;
    return {
      uid: user.uid,
      name: profileDisplayName || user.displayName || 'Usuário',
      email: user.email,
      isDemo: !!user.isDemo,
    };
  }, [user, profileDisplayName]);

  // Navegação e App Shell (com persistência de mês para não resetar no reload)
  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [selectedMonth, setSelectedMonth] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('mpf_selected_month');
      if (saved && /^\d{4}-\d{2}$/.test(saved)) return saved;
    } catch {}
    return '2026-11';
  });
  const [dashboardScope, setDashboardScope] = useState('overview');

  // Sincroniza mês selecionado no localStorage para manter a visualização após recarregar a página
  useEffect(() => {
    try {
      localStorage.setItem('mpf_selected_month', selectedMonth);
    } catch {}
  }, [selectedMonth]);

  // Dados Financeiros Pessoais (com inicialização imediata do cache local para resiliência total)
  const [accounts, setAccounts] = useState<Account[]>(() =>
    loadLocalMpfData<Account[]>('mpf_last_accounts', [])
  );
  const [categories, setCategories] = useState<Category[]>(() =>
    loadLocalMpfData<Category[]>('mpf_last_categories', [])
  );
  const [spaces, setSpaces] = useState<Space[]>(() =>
    loadLocalMpfData<Space[]>('mpf_last_spaces', [])
  );
  const [transactions, setTransactions] = useState<Transaction[]>(() =>
    loadLocalMpfData<Transaction[]>('mpf_last_transactions', [])
  );

  // Funções sincronizadas de atualização que persistem instantaneamente no localStorage
  const syncTransactionsState = (
    nextOrUpdater: Transaction[] | ((prev: Transaction[]) => Transaction[]),
    targetUid?: string
  ) => {
    setTransactions((prev) => {
      const next = typeof nextOrUpdater === 'function' ? nextOrUpdater(prev) : nextOrUpdater;
      const uid = targetUid || currentUser?.uid;
      if (uid) {
        saveLocalMpfData(`mpf_txs_${uid}`, next);
      }
      saveLocalMpfData('mpf_last_transactions', next);
      return next;
    });
  };

  const syncAccountsState = (
    nextOrUpdater: Account[] | ((prev: Account[]) => Account[]),
    targetUid?: string
  ) => {
    setAccounts((prev) => {
      const next = typeof nextOrUpdater === 'function' ? nextOrUpdater(prev) : nextOrUpdater;
      const uid = targetUid || currentUser?.uid;
      if (uid) {
        saveLocalMpfData(`mpf_accs_${uid}`, next);
      }
      saveLocalMpfData('mpf_last_accounts', next);
      return next;
    });
  };

  const syncCategoriesState = (
    nextOrUpdater: Category[] | ((prev: Category[]) => Category[]),
    targetUid?: string
  ) => {
    setCategories((prev) => {
      const next = typeof nextOrUpdater === 'function' ? nextOrUpdater(prev) : nextOrUpdater;
      const uid = targetUid || currentUser?.uid;
      if (uid) {
        saveLocalMpfData(`mpf_cats_${uid}`, next);
      }
      saveLocalMpfData('mpf_last_categories', next);
      return next;
    });
  };

  const syncSpacesState = (
    nextOrUpdater: Space[] | ((prev: Space[]) => Space[]),
    targetUid?: string
  ) => {
    setSpaces((prev) => {
      const next = typeof nextOrUpdater === 'function' ? nextOrUpdater(prev) : nextOrUpdater;
      const uid = targetUid || currentUser?.uid;
      if (uid) {
        saveLocalMpfData(`mpf_spaces_${uid}`, next);
      }
      saveLocalMpfData('mpf_last_spaces', next);
      return next;
    });
  };

  // Dados Globais do Painel de Administração (exclusivos para ADMIN_UID)
  const [adminUsers, setAdminUsers] = useState<UserProfile[]>([]);
  const [adminAccounts, setAdminAccounts] = useState<Account[]>([]);
  const [adminCategories, setAdminCategories] = useState<Category[]>([]);
  const [adminSpaces, setAdminSpaces] = useState<Space[]>([]);
  const [adminTransactions, setAdminTransactions] = useState<Transaction[]>([]);

  // Estados de Modais e Gavetas Globais
  const [isTxModalOpen, setIsTxModalOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [presetAccountId, setPresetAccountId] = useState<string | undefined>(
    undefined
  );
  const [presetSpaceId, setPresetSpaceId] = useState<string | undefined>(
    undefined
  );
  const [presetTxType, setPresetTxType] = useState<TransactionType | undefined>(
    undefined
  );
  const [presetDescription, setPresetDescription] = useState<
    string | undefined
  >(undefined);
  const [presetAmount, setPresetAmount] = useState<number | undefined>(
    undefined
  );
  const [inspectAcqWorkspaceId, setInspectAcqWorkspaceId] = useState<
    string | null
  >(null);
  const [createSpacePreset, setCreateSpacePreset] = useState<
    'finance' | 'acquisitions' | 'both' | null
  >(null);
  const [activeLedgerSpace, setActiveLedgerSpace] = useState<Space | null>(null);
  const [detailTx, setDetailTx] = useState<Transaction | null>(null);
  const [settlingTxModal, setSettlingTxModal] = useState<{
    tx: Transaction;
    defaultSpaceMode?: 'space_cash' | 'member_direct';
  } | null>(null);

  // Estados de Configurações Globais & Perfil de Usuário
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [settingsModalTab, setSettingsModalTab] = useState<SettingsTab>('account');
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);

  // Listas, itens e taxonomia de aquisições compartilhadas para exibição no Dashboard e Configurações
  const [acqLists, setAcqLists] = useState<AcquisitionList[]>(() => {
    const saved = localStorage.getItem('app_aquisicoes_lists');
    return saved ? JSON.parse(saved) : INITIAL_LISTS;
  });
  const [acqItems, setAcqItems] = useState<AcquisitionItem[]>(() => {
    const saved = localStorage.getItem('app_aquisicoes_items');
    return saved ? JSON.parse(saved) : INITIAL_ITEMS;
  });
  const [acqTaxonomyGroups, setAcqTaxonomyGroups] = useState<TaxonomyGroup[]>(() => {
    const saved = localStorage.getItem('app_aquisicoes_taxonomy');
    return saved ? JSON.parse(saved) : INITIAL_TAXONOMY_GROUPS;
  });

  // Atualização reativa de dados de aquisições quando o usuário altera no módulo
  useEffect(() => {
    const syncAcq = () => {
      try {
        const savedL = localStorage.getItem('app_aquisicoes_lists');
        if (savedL) setAcqLists(JSON.parse(savedL));
        const savedI = localStorage.getItem('app_aquisicoes_items');
        if (savedI) setAcqItems(JSON.parse(savedI));
        const savedT = localStorage.getItem('app_aquisicoes_taxonomy');
        if (savedT) setAcqTaxonomyGroups(JSON.parse(savedT));
      } catch (err) {
        console.warn('Erro ao sincronizar dados de aquisições:', err);
      }
    };
    window.addEventListener('storage', syncAcq);
    return () => window.removeEventListener('storage', syncAcq);
  }, []);

  const [dismissedSpaceNotifIds, setDismissedSpaceNotifIds] = useState<string[]>(
    () => {
      try {
        const raw = localStorage.getItem('mpf_dismissed_space_notifs');
        return raw ? JSON.parse(raw) : [];
      } catch {
        return [];
      }
    }
  );
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [cloudStatus, setCloudStatus] =
    useState<FirestoreCloudStatus>('checking');
  const [cloudBannerDismissed, setCloudBannerDismissed] = useState(false);

  useEffect(() => {
    return subscribeToFirestoreCloudStatus((status) => {
      setCloudStatus(status);
    });
  }, []);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => {
      setToastMsg((prev) => (prev === msg ? null : prev));
    }, 4500);
  };

  // Controle de sessão real via Firebase Auth (com suporte opcional a ?autostart=1 ou ?autostart=admin para verificação automatizada)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const autostartMode = params.get('autostart');
    if (autostartMode === 'admin') {
      const adminDemo = getAdminDemoDataset();
      setAdminUsers(adminDemo.users);
      setAdminAccounts(adminDemo.accounts);
      setAdminCategories(adminDemo.categories);
      setAdminSpaces(adminDemo.spaces);
      setAdminTransactions(adminDemo.transactions);
      enterDemoSession({
        uid: ADMIN_UID,
        name: 'Keniel Calixto',
        email: 'kenielcalixtonkenny@gmail.com',
      });
      setActiveTab('admin');
      return;
    }

    if (autostartMode === '1') {
      const profile = {
        uid: 'demo_keniel_uid',
        name: 'Keniel Calixto',
        email: 'kenielcalixtonkenny@gmail.com',
      };
      enterDemoSession(profile);
      return;
    }
  }, []);

  // Sincroniza dados locais em cache para o usuário autenticado atual
  useEffect(() => {
    if (!user) {
      setAccounts([]);
      setCategories([]);
      setSpaces([]);
      setTransactions([]);
      return;
    }

    const uid = user.uid;
    const userIsAdmin = isAdminUid(uid);
    setActiveTab((prev) => (userIsAdmin && prev === 'dashboard' ? 'admin' : prev));

    const cachedTxs = loadLocalMpfData<Transaction[]>(`mpf_txs_${uid}`, []);
    if (cachedTxs.length > 0) syncTransactionsState(cachedTxs, uid);
    const cachedAccs = loadLocalMpfData<Account[]>(`mpf_accs_${uid}`, []);
    if (cachedAccs.length > 0) syncAccountsState(cachedAccs, uid);
    const cachedCats = loadLocalMpfData<Category[]>(`mpf_cats_${uid}`, []);
    if (cachedCats.length > 0) syncCategoriesState(cachedCats, uid);
    const cachedSpaces = loadLocalMpfData<Space[]>(`mpf_spaces_${uid}`, []);
    if (cachedSpaces.length > 0) syncSpacesState(cachedSpaces, uid);
  }, [user?.uid]);

  const enterDemoSession = (profile: {
    uid: string;
    name: string;
    email: string;
  }) => {
    enterDemoMode(profile);
    const cachedTxs = loadLocalMpfData<Transaction[]>(`mpf_txs_${profile.uid}`, []);
    const cachedAccs = loadLocalMpfData<Account[]>(`mpf_accs_${profile.uid}`, []);
    const cachedCats = loadLocalMpfData<Category[]>(`mpf_cats_${profile.uid}`, []);
    const cachedSpaces = loadLocalMpfData<Space[]>(`mpf_spaces_${profile.uid}`, []);
    const seed = getInitialDemoData(profile.uid, profile.email, profile.name);

    syncAccountsState(cachedAccs.length > 0 ? cachedAccs : seed.accounts, profile.uid);
    syncCategoriesState(cachedCats.length > 0 ? cachedCats : seed.categories, profile.uid);
    syncSpacesState(cachedSpaces.length > 0 ? cachedSpaces : seed.spaces, profile.uid);
    syncTransactionsState(cachedTxs.length > 0 ? cachedTxs : seed.transactions, profile.uid);
  };

  // Listeners onSnapshot em tempo real para usuários autenticados no Firebase
  useEffect(() => {
    if (!currentUser || currentUser.isDemo) return;

    const uid = currentUser.uid;
    const email = currentUser.email.toLowerCase();
    const userIsAdmin = isAdminUid(uid);
    const seed = getInitialDemoData(uid, email, currentUser.name);
    const seedFlagKey = `mpf_seeded_v2_${uid}`;
    let creatingUserDoc = false;

    // Garante dados imediatos do cache local ou seed inicial
    const cachedAccs = loadLocalMpfData<Account[]>(`mpf_accs_${uid}`, []);
    const cachedCats = loadLocalMpfData<Category[]>(`mpf_cats_${uid}`, []);
    const cachedSpaces = loadLocalMpfData<Space[]>(`mpf_spaces_${uid}`, []);
    const cachedTxs = loadLocalMpfData<Transaction[]>(`mpf_txs_${uid}`, []);

    syncAccountsState((prev) => (prev.length === 0 ? (cachedAccs.length > 0 ? cachedAccs : seed.accounts) : prev), uid);
    syncCategoriesState((prev) => (prev.length === 0 ? (cachedCats.length > 0 ? cachedCats : seed.categories) : prev), uid);
    syncSpacesState((prev) => (prev.length === 0 ? (cachedSpaces.length > 0 ? cachedSpaces : seed.spaces) : prev), uid);
    syncTransactionsState((prev) => (prev.length === 0 ? (cachedTxs.length > 0 ? cachedTxs : seed.transactions) : prev), uid);

    if (userIsAdmin) {
      const adminDemo = getAdminDemoDataset();
      setAdminUsers((prev) => (prev.length === 0 ? adminDemo.users : prev));
      setAdminAccounts((prev) =>
        prev.length === 0 ? adminDemo.accounts : prev
      );
      setAdminCategories((prev) =>
        prev.length === 0 ? adminDemo.categories : prev
      );
      setAdminSpaces((prev) => (prev.length === 0 ? adminDemo.spaces : prev));
      setAdminTransactions((prev) =>
        prev.length === 0 ? adminDemo.transactions : prev
      );
    }

    // Listener em tempo real do perfil do usuário em users/{uid}
    const unsubUserDoc = onSnapshot(
      doc(db, 'users', uid),
      async (snap) => {
        setFirestoreCloudStatus('connected', null);
        if (!snap.exists()) {
          if (creatingUserDoc) return;
          creatingUserDoc = true;
          const pendingName = sessionStorage.getItem('mpf_pending_signup_name');
          const effectiveName = (
            pendingName ||
            auth.currentUser?.displayName ||
            currentUser.name ||
            email.split('@')[0] ||
            'Usuário'
          ).slice(0, 100);
          try {
            await setDoc(doc(db, 'users', uid), {
              uid,
              name: effectiveName,
              email: email.slice(0, 160),
              createdAt: serverTimestamp(),
            });
            sessionStorage.removeItem('mpf_pending_signup_name');
          } catch (e) {
            creatingUserDoc = false;
            handleFirestoreError(e, OperationType.CREATE, `users/${uid}`);
          }
          return;
        }
        const data = snap.data();
        if (data?.name) {
          setProfileDisplayName(String(data.name));
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, `users/${uid}`)
    );

    const accQuery = query(collection(db, 'accounts'), where('userId', '==', uid));
    const unsubAcc = onSnapshot(
      accQuery,
      async (snap) => {
        if (snap.empty && !localStorage.getItem(`${seedFlagKey}_acc`)) {
          localStorage.setItem(`${seedFlagKey}_acc`, '1');
          for (const acc of seed.accounts) {
            const { id, ...rest } = acc;
            const docId = `${uid}_${id}`;
            try {
              await setDoc(doc(db, 'accounts', docId), {
                ...rest,
                userId: uid,
                createdAt: serverTimestamp(),
              });
            } catch (e) {
              handleFirestoreError(e, OperationType.CREATE, `accounts/${docId}`);
            }
          }
          return;
        }
        const cloudAccs = snap.docs.map((d) => ({ ...(d.data() as Account), id: d.id }));
        syncAccountsState((prev) => {
          const cloudIds = new Set(cloudAccs.map((a) => a.id));
          const localOnly = prev.filter((a) => !cloudIds.has(a.id));
          return [...cloudAccs, ...localOnly];
        }, uid);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'accounts')
    );

    const catQuery = query(
      collection(db, 'categories'),
      where('userId', '==', uid)
    );
    const unsubCat = onSnapshot(
      catQuery,
      async (snap) => {
        if (snap.empty && !localStorage.getItem(`${seedFlagKey}_cat`)) {
          localStorage.setItem(`${seedFlagKey}_cat`, '1');
          for (const cat of seed.categories) {
            const { id, ...rest } = cat;
            const docId = `${uid}_${id}`;
            try {
              await setDoc(doc(db, 'categories', docId), {
                ...rest,
                userId: uid,
                createdAt: serverTimestamp(),
              });
            } catch (e) {
              handleFirestoreError(e, OperationType.CREATE, `categories/${docId}`);
            }
          }
          return;
        }
        const cloudCats = snap.docs.map((d) => ({ ...(d.data() as Category), id: d.id }));
        syncCategoriesState((prev) => {
          const cloudIds = new Set(cloudCats.map((c) => c.id));
          const localOnly = prev.filter((c) => !cloudIds.has(c.id));
          return [...cloudCats, ...localOnly];
        }, uid);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'categories')
    );

    const spQuery = query(
      collection(db, 'spaces'),
      where('participantEmails', 'array-contains', email)
    );
    const unsubSp = onSnapshot(
      spQuery,
      async (snap) => {
        if (snap.empty && !localStorage.getItem(`${seedFlagKey}_sp`)) {
          localStorage.setItem(`${seedFlagKey}_sp`, '1');
          for (const sp of seed.spaces) {
            const { id, ...rest } = sp;
            const docId = `${uid}_${id}`;
            try {
              await setDoc(doc(db, 'spaces', docId), {
                ...rest,
                ownerId: uid,
                ownerEmail: email,
                createdAt: serverTimestamp(),
              });
            } catch (e) {
              handleFirestoreError(e, OperationType.CREATE, `spaces/${docId}`);
            }
          }
          return;
        }
        const cloudSpaces = snap.docs.map((d) => ({ ...(d.data() as Space), id: d.id }));
        syncSpacesState((prev) => {
          const cloudIds = new Set(cloudSpaces.map((s) => s.id));
          const localOnly = prev.filter((s) => !cloudIds.has(s.id));
          return [...cloudSpaces, ...localOnly];
        }, uid);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'spaces')
    );

    const txQuery = query(
      collection(db, 'transactions'),
      where('participantEmails', 'array-contains', email)
    );
    const unsubTx = onSnapshot(
      txQuery,
      async (snap) => {
        if (snap.empty && !localStorage.getItem(`${seedFlagKey}_tx`)) {
          localStorage.setItem(`${seedFlagKey}_tx`, '1');
          for (const tx of seed.transactions) {
            const { id, ...rest } = tx;
            const docId = `${uid}_${id}`;
            try {
              await setDoc(doc(db, 'transactions', docId), {
                ...rest,
                userId: uid,
                accountId: `${uid}_${rest.accountId}`,
                categoryId: `${uid}_${rest.categoryId}`,
                spaceId: rest.spaceId ? `${uid}_${rest.spaceId}` : '',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
            } catch (e) {
              handleFirestoreError(e, OperationType.CREATE, `transactions/${docId}`);
            }
          }
          return;
        }
        const cloudTxs = snap.docs.map((d) => ({ ...(d.data() as Transaction), id: d.id }));
        syncTransactionsState((prev) => {
          const cloudIds = new Set(cloudTxs.map((t) => t.id));
          const localOnly = prev.filter((t) => !cloudIds.has(t.id));
          return [...cloudTxs, ...localOnly];
        }, uid);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'transactions')
    );

    // Se o usuário autenticado for o Administrador (ADMIN_UID), assina todas as coleções para o Painel Admin
    let unsubAdminUsers: (() => void) | undefined;
    let unsubAdminAcc: (() => void) | undefined;
    let unsubAdminCat: (() => void) | undefined;
    let unsubAdminSp: (() => void) | undefined;
    let unsubAdminTx: (() => void) | undefined;

    if (userIsAdmin) {
      unsubAdminUsers = onSnapshot(
        collection(db, 'users'),
        (snap) => {
          setAdminUsers(
            snap.docs.map((d) => ({
              ...(d.data() as UserProfile),
              uid: d.data().uid || d.id,
            }))
          );
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'users')
      );

      unsubAdminAcc = onSnapshot(
        collection(db, 'accounts'),
        (snap) => {
          setAdminAccounts(
            snap.docs.map((d) => ({ ...(d.data() as Account), id: d.id }))
          );
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'accounts')
      );

      unsubAdminCat = onSnapshot(
        collection(db, 'categories'),
        (snap) => {
          setAdminCategories(
            snap.docs.map((d) => ({ ...(d.data() as Category), id: d.id }))
          );
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'categories')
      );

      unsubAdminSp = onSnapshot(
        collection(db, 'spaces'),
        (snap) => {
          setAdminSpaces(
            snap.docs.map((d) => ({ ...(d.data() as Space), id: d.id }))
          );
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'spaces')
      );

      unsubAdminTx = onSnapshot(
        collection(db, 'transactions'),
        (snap) => {
          setAdminTransactions(
            snap.docs.map((d) => ({ ...(d.data() as Transaction), id: d.id }))
          );
        },
        (err) => handleFirestoreError(err, OperationType.LIST, 'transactions')
      );
    }

    return () => {
      unsubUserDoc();
      unsubAcc();
      unsubCat();
      unsubSp();
      unsubTx();
      if (unsubAdminUsers) unsubAdminUsers();
      if (unsubAdminAcc) unsubAdminAcc();
      if (unsubAdminCat) unsubAdminCat();
      if (unsubAdminSp) unsubAdminSp();
      if (unsubAdminTx) unsubAdminTx();
    };
  }, [currentUser?.uid, currentUser?.email, currentUser?.isDemo]);

  // Handlers de Mutação (funcionam tanto com Firestore real-time quanto na sessão demonstrativa)
  const handleCreateAccount = async (
    accData: Omit<Account, 'id' | 'userId'>
  ) => {
    if (!currentUser) return;
    const id = `acc_${Date.now()}`;
    const newAcc: Account = {
      ...accData,
      id,
      userId: currentUser.uid,
    };

    if (currentUser.isDemo) {
      setAccounts((prev) => [...prev, newAcc]);
      showToast(`Conta/Cartão "${accData.name}" cadastrado com sucesso.`);
      return;
    }

    try {
      await setDoc(doc(db, 'accounts', id), {
        ...accData,
        userId: currentUser.uid,
        createdAt: serverTimestamp(),
      });
      showToast(`Conta/Cartão "${accData.name}" sincronizado no Firestore.`);
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, `accounts/${id}`);
      syncAccountsState((prev) => [...prev, newAcc]);
      showToast(`Conta/Cartão "${accData.name}" salvo localmente.`);
    }
  };

  const handleUpdateAccount = async (
    accountId: string,
    accData: Omit<Account, 'id' | 'userId'>
  ) => {
    if (!currentUser) return;
    syncAccountsState((prev) =>
      prev.map((a) => (a.id === accountId ? { ...a, ...accData } : a))
    );
    syncTransactionsState((prev) =>
      prev.map((tx) =>
        tx.accountId === accountId
          ? { ...tx, accountName: accData.name, accountType: accData.type }
          : tx
      )
    );

    if (currentUser.isDemo) {
      showToast(`Conta/Cartão "${accData.name}" atualizado com sucesso.`);
      return;
    }

    try {
      await updateDoc(doc(db, 'accounts', accountId), {
        name: accData.name,
        type: accData.type,
        balance: accData.balance,
        limit: accData.limit,
        closingDay: accData.closingDay,
        dueDay: accData.dueDay,
        color: accData.color,
        icon: accData.icon,
      });

      // Atualiza também o nome/tipo da conta nas transações associadas de propriedade do usuário
      const relatedTxs = transactions.filter(
        (tx) =>
          tx.accountId === accountId &&
          tx.userId === currentUser.uid &&
          (tx.accountName !== accData.name || tx.accountType !== accData.type)
      );
      for (const tx of relatedTxs) {
        await updateDoc(doc(db, 'transactions', tx.id), {
          accountName: accData.name,
          accountType: accData.type,
          updatedAt: serverTimestamp(),
        });
      }

      showToast(`Conta/Cartão "${accData.name}" atualizado no Firestore.`);
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `accounts/${accountId}`);
      showToast(`Conta/Cartão "${accData.name}" atualizado localmente.`);
    }
  };

  const handleDeleteAccount = async (accountId: string) => {
    if (!currentUser) return;
    syncAccountsState((prev) => prev.filter((a) => a.id !== accountId));

    if (currentUser.isDemo) {
      showToast('Conta/Cartão excluído com sucesso.');
      return;
    }
    try {
      await deleteDoc(doc(db, 'accounts', accountId));
      showToast('Conta/Cartão excluído do Firestore.');
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `accounts/${accountId}`);
      showToast('Conta/Cartão excluído localmente.');
    }
  };

  const handlePayInvoice = async (
    card: Account,
    invoiceMonth: string,
    _sourceCheckingId: string
  ) => {
    if (!currentUser) return;
    const today = getTodayDateString();
    const targetItems = transactions.filter(
      (tx) =>
        tx.accountId === card.id &&
        tx.invoiceMonth === invoiceMonth &&
        tx.status !== 'paid' &&
        tx.status !== 'rejected'
    );

    syncTransactionsState((prev) =>
      prev.map((tx) =>
        targetItems.some((t) => t.id === tx.id)
          ? { ...tx, status: 'paid', paymentDate: today }
          : tx
      )
    );

    if (currentUser.isDemo) {
      showToast(
        `Fatura ${invoiceMonth} do cartão ${card.name} paga com sucesso em ${today}!`
      );
      return;
    }

    try {
      for (const item of targetItems) {
        await updateDoc(doc(db, 'transactions', item.id), {
          status: 'paid',
          paymentDate: today,
          updatedAt: serverTimestamp(),
        });
      }
      showToast(`Fatura ${invoiceMonth} do cartão ${card.name} liquidada!`);
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, 'transactions');
      showToast(`Fatura ${invoiceMonth} do cartão ${card.name} liquidada localmente!`);
    }
  };

  const handleCreateCategory = async (
    catData: Omit<Category, 'id' | 'userId'>
  ): Promise<Category> => {
    const uid = currentUser?.uid || 'demo_uid';
    const id = `cat_${Date.now()}`;
    const newCat: Category = { ...catData, id, userId: uid };
    syncCategoriesState((prev) => [...prev, newCat]);

    if (!currentUser || currentUser.isDemo) {
      return newCat;
    }

    try {
      await setDoc(doc(db, 'categories', id), {
        ...catData,
        userId: uid,
        createdAt: serverTimestamp(),
      });
      return newCat;
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, `categories/${id}`);
      return newCat;
    }
  };

  const handleDeleteCategory = async (catId: string) => {
    if (!currentUser) return;
    if (currentUser.isDemo) {
      setCategories((prev) => prev.filter((c) => c.id !== catId));
      showToast('Categoria removida com sucesso.');
      return;
    }
    try {
      await deleteDoc(doc(db, 'categories', catId));
      showToast('Categoria removida do Firestore.');
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `categories/${catId}`);
      setCategories((prev) => prev.filter((c) => c.id !== catId));
      showToast('Categoria removida localmente.');
    }
  };

  const handleUpdateUserName = async (newName: string) => {
    if (!currentUser) return;
    const trimmed = newName.trim();
    if (!trimmed) return;
    setProfileDisplayName(trimmed);
    if (!currentUser.isDemo && auth.currentUser) {
      try {
        await updateDoc(doc(db, 'users', currentUser.uid), {
          displayName: trimmed,
          name: trimmed,
        });
      } catch (err) {
        console.warn('Could not persist updated name to Firestore:', err);
      }
    }
    showToast('Nome atualizado com sucesso!');
  };

  const handleAddTaxonomyGroup = (
    name: string,
    code: string,
    description: string
  ) => {
    const newGrp: TaxonomyGroup = {
      id: `grp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim(),
      code: code.trim().toUpperCase(),
      description: description.trim(),
      categories: [
        {
          id: `cat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          groupId: '',
          name: 'Geral',
        },
      ],
    };
    newGrp.categories[0].groupId = newGrp.id;
    setAcqTaxonomyGroups((prev) => {
      const updated = [newGrp, ...prev];
      localStorage.setItem('app_aquisicoes_taxonomy', JSON.stringify(updated));
      return updated;
    });
    saveTaxonomyGroupToFirestore(newGrp);
  };

  const handleUpdateTaxonomyGroup = (
    id: string,
    name: string,
    description: string
  ) => {
    setAcqTaxonomyGroups((prev) => {
      const updated = prev.map((g) =>
        g.id === id ? { ...g, name, description } : g
      );
      localStorage.setItem('app_aquisicoes_taxonomy', JSON.stringify(updated));
      const found = updated.find((g) => g.id === id);
      if (found) saveTaxonomyGroupToFirestore(found);
      return updated;
    });
  };

  const handleDeleteTaxonomyGroup = (id: string) => {
    setAcqTaxonomyGroups((prev) => {
      const updated = prev.filter((g) => g.id !== id);
      localStorage.setItem('app_aquisicoes_taxonomy', JSON.stringify(updated));
      return updated;
    });
    deleteTaxonomyGroupFromFirestore(id);
  };

  const handleAddTaxonomyCategory = (
    groupId: string,
    categoryName: string
  ) => {
    setAcqTaxonomyGroups((prev) => {
      const updated = prev.map((g) => {
        if (g.id !== groupId) return g;
        const newCat = {
          id: `cat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          groupId,
          name: categoryName.trim(),
        };
        const next = { ...g, categories: [...g.categories, newCat] };
        saveTaxonomyGroupToFirestore(next);
        return next;
      });
      localStorage.setItem('app_aquisicoes_taxonomy', JSON.stringify(updated));
      return updated;
    });
  };

  const handleUpdateTaxonomyCategory = (
    groupId: string,
    categoryId: string,
    categoryName: string
  ) => {
    setAcqTaxonomyGroups((prev) => {
      const updated = prev.map((g) => {
        if (g.id !== groupId) return g;
        const next = {
          ...g,
          categories: g.categories.map((c) =>
            c.id === categoryId ? { ...c, name: categoryName } : c
          ),
        };
        saveTaxonomyGroupToFirestore(next);
        return next;
      });
      localStorage.setItem('app_aquisicoes_taxonomy', JSON.stringify(updated));
      return updated;
    });
  };

  const handleDeleteTaxonomyCategory = (
    groupId: string,
    categoryId: string
  ) => {
    setAcqTaxonomyGroups((prev) => {
      const updated = prev.map((g) => {
        if (g.id !== groupId) return g;
        const next = {
          ...g,
          categories: g.categories.filter((c) => c.id !== categoryId),
        };
        saveTaxonomyGroupToFirestore(next);
        return next;
      });
      localStorage.setItem('app_aquisicoes_taxonomy', JSON.stringify(updated));
      return updated;
    });
  };

  const handleSaveTransactionSeries = async (
    series: Omit<Transaction, 'id'>[],
    editingTransaction: Transaction | null,
    cascadeMode: CascadeMode
  ) => {
    if (!currentUser) return;

    if (editingTransaction) {
      const targets = filterCascadeTargets(
        transactions,
        editingTransaction,
        cascadeMode
      );
      const updatedSample = series[0];

      syncTransactionsState((prev) =>
        prev.map((tx) => {
          if (!targets.some((t) => t.id === tx.id)) return tx;
          const suffix =
            tx.recurrenceType === 'installment'
              ? ` (${tx.installmentIndex}/${tx.installmentTotal})`
              : '';
          const cleanBase = updatedSample.description.replace(
            /\s*\(\d+\/\d+\)$/,
            ''
          );
          return {
            ...tx,
            description: `${cleanBase}${suffix}`,
            amount: updatedSample.amount,
            status: updatedSample.status,
            paymentDate: updatedSample.paymentDate || '',
            categoryId: updatedSample.categoryId,
            categoryName: updatedSample.categoryName,
            categoryIcon: updatedSample.categoryIcon,
            categoryColor: updatedSample.categoryColor,
            accountId: updatedSample.accountId,
            accountName: updatedSample.accountName,
            accountType: updatedSample.accountType,
            spaceId: updatedSample.spaceId,
            spaceName: updatedSample.spaceName,
            paidByEmail: updatedSample.paidByEmail,
            recipientEmail: updatedSample.recipientEmail || '',
            participantEmails: updatedSample.participantEmails,
            splits: updatedSample.splits,
          };
        })
      );

      if (currentUser.isDemo) {
        showToast(
          `Alteração aplicada em ${targets.length} lançamento(s) (${
            cascadeMode === 'only_this'
              ? 'Somente este'
              : cascadeMode === 'this_and_following'
              ? 'Este e seguintes'
              : 'Toda a série'
          }).`
        );
        return;
      }

      try {
        for (const t of targets) {
          const suffix =
            t.recurrenceType === 'installment'
              ? ` (${t.installmentIndex}/${t.installmentTotal})`
              : '';
          const cleanBase = updatedSample.description.replace(
            /\s*\(\d+\/\d+\)$/,
            ''
          );
          await updateDoc(doc(db, 'transactions', t.id), {
            description: `${cleanBase}${suffix}`.slice(0, 140),
            amount: updatedSample.amount,
            status: updatedSample.status,
            paymentDate: updatedSample.paymentDate || '',
            categoryId: updatedSample.categoryId,
            categoryName: updatedSample.categoryName,
            categoryIcon: updatedSample.categoryIcon,
            categoryColor: updatedSample.categoryColor,
            accountId: updatedSample.accountId,
            accountName: updatedSample.accountName,
            accountType: updatedSample.accountType,
            spaceId: updatedSample.spaceId,
            spaceName: updatedSample.spaceName,
            paidByEmail: updatedSample.paidByEmail,
            recipientEmail: updatedSample.recipientEmail || '',
            participantEmails: updatedSample.participantEmails,
            splits: updatedSample.splits,
            updatedAt: serverTimestamp(),
          });
        }
        showToast(`Edição em cascata concluída (${targets.length} itens).`);
      } catch (e) {
        handleFirestoreError(e, OperationType.UPDATE, 'transactions');
        showToast('Edição em cascata salva com segurança localmente.');
      }
      return;
    }

    // Criação de novo lançamento (ou série fixa/parcelada)
    const createdWithIds: Transaction[] = series.map((item, idx) => ({
      ...item,
      id: `tx_${Date.now()}_${idx}`,
    }));

    // Persiste instantaneamente no estado e no cache local (nunca se perde no reload)
    syncTransactionsState((prev) => {
      const filtered = prev.filter((t) => !createdWithIds.some((c) => c.id === t.id));
      return [...createdWithIds, ...filtered];
    });

    if (currentUser.isDemo) {
      showToast(
        createdWithIds.length > 1
          ? `${createdWithIds.length} parcelas/recorrências geradas com sucesso!`
          : 'Lançamento registrado com sucesso!'
      );
      return;
    }

    try {
      for (const item of createdWithIds) {
        const { id, ...rest } = item;
        await setDoc(doc(db, 'transactions', id), {
          ...rest,
          paymentDate: rest.paymentDate || '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      showToast('Lançamento registrado e sincronizado com sucesso!');
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, 'transactions');
      showToast('Lançamento gravado localmente com segurança no dispositivo!');
    }
  };

  const handleUpdateStatusCascade = async (
    tx: Transaction,
    newStatus: TransactionStatus,
    mode: CascadeMode,
    paymentDate?: string
  ) => {
    if (!currentUser) return;
    const targets = filterCascadeTargets(transactions, tx, mode);
    const effectivePaymentDate =
      newStatus === 'paid' ? paymentDate || getTodayDateString() : '';

    syncTransactionsState((prev) =>
      prev.map((item) => {
        if (!targets.some((t) => t.id === item.id)) return item;
        const nextStatus =
          newStatus === 'paid'
            ? 'paid'
            : computeAutomatedStatus({
                isPaid: false,
                paymentDate: '',
                dueDate: item.dueDate,
                splits: item.splits,
                spaceId: item.spaceId,
              });
        return {
          ...item,
          status: nextStatus,
          paymentDate: effectivePaymentDate,
        };
      })
    );

    if (currentUser.isDemo) {
      showToast(
        newStatus === 'paid'
          ? `Lançamento efetivado como Pago em ${effectivePaymentDate}!`
          : `Status recalculado automaticamente em ${targets.length} lançamento(s).`
      );
      return;
    }

    try {
      for (const t of targets) {
        const nextStatus =
          newStatus === 'paid'
            ? 'paid'
            : computeAutomatedStatus({
                isPaid: false,
                paymentDate: '',
                dueDate: t.dueDate,
                splits: t.splits,
                spaceId: t.spaceId,
              });
        await updateDoc(doc(db, 'transactions', t.id), {
          status: nextStatus,
          paymentDate: effectivePaymentDate,
          updatedAt: serverTimestamp(),
        });
      }
      showToast(
        newStatus === 'paid'
          ? `Lançamento efetivado como Pago em ${effectivePaymentDate}!`
          : `Status atualizado em ${targets.length} lançamento(s).`
      );
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, 'transactions');
    }
  };

  const handleDeleteCascade = async (tx: Transaction, mode: CascadeMode) => {
    if (!currentUser) return;
    const targets = filterCascadeTargets(transactions, tx, mode);

    syncTransactionsState((prev) =>
      prev.filter((item) => !targets.some((t) => t.id === item.id))
    );

    if (currentUser.isDemo) {
      showToast(`${targets.length} lançamento(s) excluído(s).`);
      return;
    }

    try {
      for (const t of targets) {
        await deleteDoc(doc(db, 'transactions', t.id));
      }
      showToast(`${targets.length} lançamento(s) excluído(s).`);
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, 'transactions');
    }
  };

  const handleCreateSpace = async (
    spData: Omit<Space, 'id' | 'ownerId' | 'ownerEmail'>
  ) => {
    if (!currentUser) return;
    const id = `space_${Date.now()}`;
    const newSp: Space = {
      ...spData,
      id,
      ownerId: currentUser.uid,
      ownerEmail: currentUser.email,
      enabledModules: spData.enabledModules || ['finance'],
      monthlyBudget: spData.monthlyBudget || 0,
    };

    // Se o espaço incluir Aquisições, inicializar lista padrão se ainda não existir
    if (newSp.enabledModules?.includes('acquisitions')) {
      try {
        const storedLists = localStorage.getItem('app_aquisicoes_lists');
        const currentLists = storedLists ? JSON.parse(storedLists) : [];
        const hasLists = currentLists.some((l: any) => l.workspaceId === id);
        if (!hasLists) {
          const defaultList = {
            id: `list_${id}_default`,
            workspaceId: id,
            name: 'Compras do Mês',
            type: 'recorrente',
            description: `Lista principal de compras recorrentes para o espaço ${spData.name}`,
            acceptedMemberEmails: spData.participantEmails || [currentUser.email.toLowerCase()],
            createdAt: new Date().toISOString(),
          };
          localStorage.setItem('app_aquisicoes_lists', JSON.stringify([...currentLists, defaultList]));
        }
      } catch {
        // ignore
      }
    }

    if (currentUser.isDemo) {
      setSpaces((prev) => [...prev, newSp]);
      showToast(`Espaço "${spData.name}" criado com sucesso!`);
      return;
    }

    try {
      await setDoc(doc(db, 'spaces', id), {
        ...spData,
        enabledModules: spData.enabledModules || ['finance'],
        monthlyBudget: spData.monthlyBudget || 0,
        ownerId: currentUser.uid,
        ownerEmail: currentUser.email,
        createdAt: serverTimestamp(),
      });
      showToast(`Espaço "${spData.name}" criado no Firestore!`);
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, `spaces/${id}`);
      setSpaces((prev) => [...prev, newSp]);
    }
  };

  const handleUpdateSpace = async (
    spaceId: string,
    spData: Omit<Space, 'id' | 'ownerId' | 'ownerEmail'>
  ) => {
    if (!currentUser) return;

    // Se passou a incluir Aquisições, garantir lista padrão
    if (spData.enabledModules?.includes('acquisitions')) {
      try {
        const storedLists = localStorage.getItem('app_aquisicoes_lists');
        const currentLists = storedLists ? JSON.parse(storedLists) : [];
        const hasLists = currentLists.some((l: any) => l.workspaceId === spaceId);
        if (!hasLists) {
          const defaultList = {
            id: `list_${spaceId}_default`,
            workspaceId: spaceId,
            name: 'Compras do Mês',
            type: 'recorrente',
            description: `Lista principal de compras para o espaço ${spData.name}`,
            acceptedMemberEmails: spData.participantEmails || [currentUser.email.toLowerCase()],
            createdAt: new Date().toISOString(),
          };
          localStorage.setItem('app_aquisicoes_lists', JSON.stringify([...currentLists, defaultList]));
        }
      } catch {
        // ignore
      }
    }

    if (currentUser.isDemo) {
      setSpaces((prev) =>
        prev.map((s) => (s.id === spaceId ? { ...s, ...spData } : s))
      );
      setTransactions((prev) =>
        prev.map((tx) =>
          tx.spaceId === spaceId ? { ...tx, spaceName: spData.name } : tx
        )
      );
      if (activeLedgerSpace && activeLedgerSpace.id === spaceId) {
        setActiveLedgerSpace({ ...activeLedgerSpace, ...spData });
      }
      showToast(`Espaço "${spData.name}" atualizado com sucesso!`);
      return;
    }

    try {
      await updateDoc(doc(db, 'spaces', spaceId), {
        name: spData.name,
        description: spData.description,
        icon: spData.icon,
        color: spData.color,
        participantEmails: spData.participantEmails,
        participants: spData.participants,
        enabledModules: spData.enabledModules || ['finance'],
        monthlyBudget: spData.monthlyBudget || 0,
      });

      const relatedTxs = transactions.filter(
        (tx) =>
          tx.spaceId === spaceId &&
          tx.userId === currentUser.uid &&
          tx.spaceName !== spData.name
      );
      for (const tx of relatedTxs) {
        await updateDoc(doc(db, 'transactions', tx.id), {
          spaceName: spData.name,
          updatedAt: serverTimestamp(),
        });
      }

      if (activeLedgerSpace && activeLedgerSpace.id === spaceId) {
        setActiveLedgerSpace({ ...activeLedgerSpace, ...spData });
      }
      showToast(`Espaço "${spData.name}" atualizado no Firestore!`);
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `spaces/${spaceId}`);
      setSpaces((prev) =>
        prev.map((s) => (s.id === spaceId ? { ...s, ...spData } : s))
      );
    }
  };

  const handleDeleteSpace = async (spaceId: string) => {
    if (!currentUser) return;
    if (dashboardScope === spaceId) {
      setDashboardScope('overview');
    }
    if (activeLedgerSpace && activeLedgerSpace.id === spaceId) {
      setActiveLedgerSpace(null);
    }

    if (currentUser.isDemo) {
      setSpaces((prev) => prev.filter((s) => s.id !== spaceId));
      showToast('Espaço compartilhado excluído com sucesso.');
      return;
    }

    try {
      await deleteDoc(doc(db, 'spaces', spaceId));
      showToast('Espaço compartilhado excluído do Firestore.');
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `spaces/${spaceId}`);
    }
  };

  const handleInviteToSpace = async (
    spaceId: string,
    email: string,
    name: string
  ) => {
    if (!currentUser) return;
    const target = spaces.find((s) => s.id === spaceId);
    if (!target) return;

    const updatedEmails = Array.from(
      new Set([...target.participantEmails, email.toLowerCase()])
    ).slice(0, 20);
    const existsPart = target.participants.some(
      (p) => p.email.toLowerCase() === email.toLowerCase()
    );
    const updatedParticipants = existsPart
      ? target.participants
      : [
          ...target.participants,
          { email: email.toLowerCase(), name, status: 'invited' as const },
        ].slice(0, 20);

    if (currentUser.isDemo) {
      setSpaces((prev) =>
        prev.map((s) =>
          s.id === spaceId
            ? {
                ...s,
                participantEmails: updatedEmails,
                participants: updatedParticipants,
              }
            : s
        )
      );
      return;
    }

    try {
      await updateDoc(doc(db, 'spaces', spaceId), {
        participantEmails: updatedEmails,
        participants: updatedParticipants,
      });
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `spaces/${spaceId}`);
    }
  };

  const handleSettleTransfer = async (
    space: Space,
    fromEmail: string,
    fromName: string,
    toEmail: string,
    toName: string,
    amount: number
  ) => {
    if (!currentUser) return;
    const today = getTodayDateString();
    const settlementTx: Transaction = {
      id: `tx_settle_${Date.now()}`,
      userId: currentUser.uid,
      ownerEmail: currentUser.email,
      ownerName: currentUser.name,
      description: `Reembolso Livro-Razão: ${fromName} -> ${toName}`,
      amount,
      type: 'expense',
      status: 'paid',
      paymentDate: today,
      categoryId: categories[0]?.id || 'cat_moradia',
      categoryName: 'Acerto de Contas',
      categoryIcon: 'ph-scales',
      categoryColor: 'emerald',
      accountId: accounts[0]?.id || 'acc_itau_personalite',
      accountName: accounts[0]?.name || 'Conta Principal',
      accountType: 'checking',
      competenceDate: today,
      dueDate: today,
      invoiceMonth: selectedMonth,
      recurrenceType: 'single',
      recurrenceGroupId: `grp_settle_${Date.now()}`,
      installmentIndex: 1,
      installmentTotal: 1,
      spaceId: space.id,
      spaceName: space.name,
      paidByEmail: fromEmail,
      participantEmails: space.participantEmails,
      splits: [
        {
          email: fromEmail,
          name: fromName,
          responsibility: 0,
          paidAmount: amount,
          status: 'accepted',
        },
        {
          email: toEmail,
          name: toName,
          responsibility: amount,
          paidAmount: 0,
          status: 'accepted',
        },
      ],
      disputeReason: '',
      proposedAmount: 0,
    };

    syncTransactionsState((prev) => [settlementTx, ...prev]);

    if (currentUser.isDemo) {
      showToast(
        `Reembolso de ${formatCurrency(amount)} (${fromName} -> ${toName}) registrado no Livro-Razão!`
      );
      return;
    }

    try {
      const { id, ...rest } = settlementTx;
      await setDoc(doc(db, 'transactions', id), {
        ...rest,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      showToast('Reembolso liquidado no Livro-Razão!');
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, 'transactions');
      showToast('Reembolso gravado localmente no Livro-Razão!');
    }
  };

  const handleConfirmSpaceIncome = async (tx: Transaction) => {
    setSettlingTxModal({ tx });
  };

  const handleSettleSpaceExpense = async (
    tx: Transaction,
    mode: 'space_cash' | 'member_direct'
  ) => {
    setSettlingTxModal({ tx, defaultSpaceMode: mode });
  };

  const handleConfirmSettlement = async (params: {
    tx: Transaction;
    confirmedAmount: number;
    paymentDate: string;
    cascadeMode: CascadeMode;
    spaceSettleMode?: 'space_cash' | 'member_direct';
    payerEmail?: string;
  }) => {
    if (!currentUser) return;
    const {
      tx,
      confirmedAmount,
      paymentDate,
      cascadeMode,
      spaceSettleMode,
      payerEmail,
    } = params;
    const effectiveDate = paymentDate || getTodayDateString();
    const amountRatio =
      tx.amount > 0 ? confirmedAmount / tx.amount : 1;

    const buildUpdatedSplitsForTarget = (
      item: Transaction,
      isCurrentTarget: boolean
    ) => {
      const baseSplits = item.splits || [];
      if (baseSplits.length === 0) return [];

      if (item.spaceId && item.type === 'income') {
        return baseSplits.map((s) => ({
          ...s,
          status: 'accepted' as const,
          paidAmount:
            isCurrentTarget &&
            s.email.toLowerCase() === item.paidByEmail.toLowerCase()
              ? confirmedAmount
              : s.paidAmount,
        }));
      }

      if (item.spaceId && item.type === 'expense') {
        const effectiveMode =
          spaceSettleMode ||
          (item.paidByEmail === 'space_cash' ? 'space_cash' : 'member_direct');
        const effectivePayer =
          effectiveMode === 'space_cash'
            ? 'space_cash'
            : (
                payerEmail ||
                (item.paidByEmail === 'space_cash'
                  ? currentUser.email
                  : item.paidByEmail)
              ).toLowerCase();

        return baseSplits.map((s) => {
          const scaledResp = Number((s.responsibility * amountRatio).toFixed(2));
          return {
            ...s,
            status: 'accepted' as const,
            responsibility: scaledResp,
            paidAmount: isCurrentTarget
              ? effectiveMode === 'member_direct' &&
                s.email.toLowerCase() === effectivePayer.toLowerCase()
                ? confirmedAmount
                : 0
              : s.paidAmount,
          };
        });
      }

      // Rateio avulso ou individual
      return baseSplits.map((s) => {
        const scaledResp = Number((s.responsibility * amountRatio).toFixed(2));
        return {
          ...s,
          responsibility: scaledResp,
          paidAmount:
            isCurrentTarget &&
            s.email.toLowerCase() === item.paidByEmail.toLowerCase()
              ? confirmedAmount
              : s.paidAmount,
        };
      });
    };

    const cascadeTargets = filterCascadeTargets(transactions, tx, cascadeMode);
    const effectivePayerForCurrent =
      tx.spaceId && tx.type === 'expense'
        ? (spaceSettleMode ||
            (tx.paidByEmail === 'space_cash'
              ? 'space_cash'
              : 'member_direct')) === 'space_cash'
          ? 'space_cash'
          : (
              payerEmail ||
              (tx.paidByEmail === 'space_cash'
                ? currentUser.email
                : tx.paidByEmail)
            ).toLowerCase()
        : tx.paidByEmail;

    syncTransactionsState((prev) =>
      prev.map((item) => {
        const isCurrent = item.id === tx.id;
        const isInCascade = cascadeTargets.some((t) => t.id === item.id);
        if (!isCurrent && !isInCascade) return item;

        if (isCurrent) {
          return {
            ...item,
            amount: confirmedAmount,
            status: 'paid',
            paymentDate: effectiveDate,
            paidByEmail: effectivePayerForCurrent,
            recipientEmail:
              item.type === 'income' && item.spaceId
                ? item.recipientEmail || currentUser.email
                : item.recipientEmail,
            splits: buildUpdatedSplitsForTarget(item, true),
          };
        }

        // Para os demais itens da série (quando cascadeMode !== 'only_this'), atualiza apenas o valor se foi reajustado
        return {
          ...item,
          amount: confirmedAmount,
          splits: buildUpdatedSplitsForTarget(item, false),
        };
      })
    );

    setSettlingTxModal(null);

    if (currentUser.isDemo) {
      showToast(
        tx.type === 'income'
          ? `Receita "${tx.description}" efetivada com valor validado de ${formatCurrency(
              confirmedAmount
            )}!`
          : `Pagamento de "${tx.description}" registrado (${formatCurrency(
              confirmedAmount
            )})!`
      );
      return;
    }

    try {
      for (const item of cascadeTargets) {
        const isCurrent = item.id === tx.id;
        if (isCurrent) {
          await updateDoc(doc(db, 'transactions', item.id), {
            amount: confirmedAmount,
            status: 'paid',
            paymentDate: effectiveDate,
            paidByEmail: effectivePayerForCurrent,
            recipientEmail:
              item.type === 'income' && item.spaceId
                ? item.recipientEmail || currentUser.email
                : item.recipientEmail || '',
            splits: buildUpdatedSplitsForTarget(item, true),
            updatedAt: serverTimestamp(),
          });
        } else {
          await updateDoc(doc(db, 'transactions', item.id), {
            amount: confirmedAmount,
            splits: buildUpdatedSplitsForTarget(item, false),
            updatedAt: serverTimestamp(),
          });
        }
      }
      showToast(
        tx.type === 'income'
          ? `Receita "${tx.description}" efetivada (${formatCurrency(
              confirmedAmount
            )})!`
          : `Pagamento de "${tx.description}" registrado (${formatCurrency(
              confirmedAmount
            )})!`
      );
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `transactions/${tx.id}`);
      showToast('Pagamento registrado localmente no dispositivo.');
    }
  };

  // Handlers de Convite de Novos Grupos / Espaços no Inbox
  const handleAcceptSpaceInvite = async (spaceId: string) => {
    if (!currentUser) return;
    const target = spaces.find((s) => s.id === spaceId);
    if (!target) return;

    const updatedParticipants = target.participants.map((p) =>
      p.email.toLowerCase() === currentUser.email.toLowerCase()
        ? { ...p, status: 'active' as const }
        : p
    );

    if (currentUser.isDemo) {
      setSpaces((prev) =>
        prev.map((s) =>
          s.id === spaceId ? { ...s, participants: updatedParticipants } : s
        )
      );
      showToast(`Você aceitou entrar no grupo "${target.name}"!`);
      return;
    }

    try {
      await updateDoc(doc(db, 'spaces', spaceId), {
        participants: updatedParticipants,
      });
      showToast(`Entrada confirmada no grupo "${target.name}"!`);
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `spaces/${spaceId}`);
    }
  };

  const handleDeclineSpaceInvite = async (spaceId: string) => {
    if (!currentUser) return;
    const target = spaces.find((s) => s.id === spaceId);
    if (!target) return;

    const updatedParticipants = target.participants.filter(
      (p) => p.email.toLowerCase() !== currentUser.email.toLowerCase()
    );
    const updatedEmails = target.participantEmails.filter(
      (em) => em.toLowerCase() !== currentUser.email.toLowerCase()
    );

    if (currentUser.isDemo) {
      setSpaces((prev) =>
        prev
          .map((s) =>
            s.id === spaceId
              ? {
                  ...s,
                  participants: updatedParticipants,
                  participantEmails: updatedEmails,
                }
              : s
          )
          .filter((s) =>
            s.participantEmails.some(
              (em) => em.toLowerCase() === currentUser.email.toLowerCase()
            )
          )
      );
      showToast(`Convite para o grupo "${target.name}" recusado.`);
      return;
    }

    try {
      await updateDoc(doc(db, 'spaces', spaceId), {
        participants: updatedParticipants,
        participantEmails: updatedEmails,
      });
      showToast(`Convite para o grupo "${target.name}" recusado.`);
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `spaces/${spaceId}`);
    }
  };

  const handleDismissSpaceNotification = (txId: string) => {
    setDismissedSpaceNotifIds((prev) => {
      const next = Array.from(new Set([...prev, txId]));
      try {
        localStorage.setItem('mpf_dismissed_space_notifs', JSON.stringify(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  const handleDismissAllSpaceNotifications = (txIds: string[]) => {
    setDismissedSpaceNotifIds((prev) => {
      const next = Array.from(new Set([...prev, ...txIds]));
      try {
        localStorage.setItem('mpf_dismissed_space_notifs', JSON.stringify(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
    showToast('Avisos do espaço apagados da Caixa de Entrada.');
  };

  // Handlers de Negociação de Pendências de Despesas Avulsas (Inbox / Dispute)
  // IMPORTANTE: Dar aceite na cota de uma despesa avulsa NÃO marca a despesa como paga/efetivada!
  // A despesa continua regida pela sua data de vencimento (No Prazo ou Vencida) até que quem paga dê baixa.
  const handleAcceptSplit = async (tx: Transaction) => {
    if (!currentUser) return;
    const updatedSplits = tx.splits.map((s) =>
      s.email.toLowerCase() === currentUser.email.toLowerCase()
        ? { ...s, status: 'accepted' as const }
        : s
    );

    const nextStatus = computeAutomatedStatus({
      isPaid: Boolean(tx.paymentDate),
      paymentDate: tx.paymentDate,
      dueDate: tx.dueDate,
      splits: updatedSplits,
      spaceId: tx.spaceId,
    });

    syncTransactionsState((prev) =>
      prev.map((item) =>
        item.id === tx.id
          ? {
              ...item,
              status: nextStatus,
              splits: updatedSplits,
              disputeReason: '',
              proposedAmount: 0,
            }
          : item
      )
    );

    if (currentUser.isDemo) {
      showToast(
        `Cota aceita em "${tx.description}"! A despesa segue no prazo de vencimento (${tx.dueDate}) aguardando baixa do pagamento.`
      );
      return;
    }

    try {
      await updateDoc(doc(db, 'transactions', tx.id), {
        status: nextStatus,
        splits: updatedSplits,
        disputeReason: '',
        proposedAmount: 0,
        updatedAt: serverTimestamp(),
      });
      showToast(`Cota aceita em "${tx.description}"!`);
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `transactions/${tx.id}`);
    }
  };

  const handleRejectSplit = async (tx: Transaction, reason: string) => {
    if (!currentUser) return;
    const updatedSplits = tx.splits.map((s) =>
      s.email.toLowerCase() === currentUser.email.toLowerCase()
        ? { ...s, status: 'rejected' as const, note: reason }
        : s
    );

    syncTransactionsState((prev) =>
      prev.map((item) =>
        item.id === tx.id
          ? {
              ...item,
              status: 'rejected',
              paymentDate: '',
              splits: updatedSplits,
              disputeReason: reason.slice(0, 300),
            }
          : item
      )
    );

    if (currentUser.isDemo) {
      showToast(`Rateio "${tx.description}" marcado como recusado.`);
      return;
    }

    try {
      await updateDoc(doc(db, 'transactions', tx.id), {
        status: 'rejected',
        paymentDate: '',
        splits: updatedSplits,
        disputeReason: reason.slice(0, 300),
        updatedAt: serverTimestamp(),
      });
      showToast(`Rateio "${tx.description}" recusado.`);
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `transactions/${tx.id}`);
    }
  };

  const handleProposeNewValue = async (
    tx: Transaction,
    proposedAmount: number,
    reason: string
  ) => {
    if (!currentUser) return;
    const oldMyShare =
      tx.splits.find(
        (s) => s.email.toLowerCase() === currentUser.email.toLowerCase()
      )?.responsibility || 0;
    const diff = oldMyShare - proposedAmount;

    const updatedSplits = tx.splits.map((s) => {
      if (s.email.toLowerCase() === currentUser.email.toLowerCase()) {
        return {
          ...s,
          responsibility: proposedAmount,
          proposedAmount,
          status: 'accepted' as const,
          note: reason,
        };
      }
      if (s.email.toLowerCase() === tx.paidByEmail.toLowerCase()) {
        return {
          ...s,
          responsibility: Math.max(0, Number((s.responsibility + diff).toFixed(2))),
        };
      }
      return s;
    });

    const nextStatus = computeAutomatedStatus({
      isPaid: Boolean(tx.paymentDate),
      paymentDate: tx.paymentDate,
      dueDate: tx.dueDate,
      splits: updatedSplits,
      spaceId: tx.spaceId,
    });

    syncTransactionsState((prev) =>
      prev.map((item) =>
        item.id === tx.id
          ? {
              ...item,
              status: nextStatus,
              splits: updatedSplits,
              proposedAmount,
              disputeReason: `Valor renegociado para ${formatCurrency(
                proposedAmount
              )}: ${reason}`.slice(0, 300),
            }
          : item
      )
    );

    if (currentUser.isDemo) {
      showToast(
        `Contraproposta de ${formatCurrency(proposedAmount)} aplicada em "${tx.description}"! A despesa segue aguardando pagamento no vencimento.`
      );
      return;
    }

    try {
      await updateDoc(doc(db, 'transactions', tx.id), {
        status: nextStatus,
        splits: updatedSplits,
        proposedAmount,
        disputeReason: `Valor renegociado: ${reason}`.slice(0, 300),
        updatedAt: serverTimestamp(),
      });
      showToast('Contraproposta registrada com sucesso!');
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `transactions/${tx.id}`);
    }
  };

  const handleLogout = async () => {
    // Limpeza mandatória de dados privados da memória ao deslogar
    setAccounts([]);
    setCategories([]);
    setSpaces([]);
    setTransactions([]);
    await logout();
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center text-slate-400 gap-3">
        <div className="w-10 h-10 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
        <span className="text-sm font-medium text-slate-300">Carregando Meu Painel Financeiro...</span>
        <span className="text-xs text-slate-500">Validando credenciais e identidade segura</span>
      </div>
    );
  }

  if (!currentUser || !isAuthenticated) {
    return <AuthScreen onEnterDemoMode={enterDemoSession} />;
  }

  const userIsAdmin = isAdminUid(currentUser.uid);
  const pendingSpaceInvitesCount = spaces.filter((sp) =>
    sp.participants?.some(
      (p) =>
        p.email.toLowerCase() === currentUser.email.toLowerCase() &&
        p.status === 'invited'
    )
  ).length;
  const pendingAdhocSplitsCount = transactions.filter(
    (tx) =>
      !tx.spaceId &&
      (tx.status === 'validating' ||
        tx.splits?.some(
          (s) =>
            s.email.toLowerCase() === currentUser.email.toLowerCase() &&
            (s.status === 'pending' || s.status === 'disputed')
        ))
  ).length;
  const pendingDisputesCount =
    pendingSpaceInvitesCount + pendingAdhocSplitsCount;

  const navItems: {
    id: NavTab;
    label: string;
    shortLabel: string;
    icon: string;
    count?: number;
  }[] = [
    {
      id: 'accounts',
      label: 'Contas & Cartões',
      shortLabel: 'Contas',
      icon: 'ph-credit-card',
    },
    {
      id: 'transactions',
      label: 'Extrato',
      shortLabel: 'Extrato',
      icon: 'ph-list-checks',
    },
    {
      id: 'spaces',
      label: 'Espaços',
      shortLabel: 'Espaços',
      icon: 'ph-scales',
    },
    {
      id: 'acquisitions',
      label: 'Listas',
      shortLabel: 'Listas',
      icon: 'ph-shopping-cart',
    },
    {
      id: 'disputes',
      label: 'Inbox',
      shortLabel: 'Inbox',
      icon: 'ph-tray',
      count: pendingDisputesCount,
    },
  ];

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col">
      {/* Área Principal do Aplicativo (Sem menu lateral; navegação superior na Web e rodapé no Mobile) */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Cabeçalho Superior Rediagramado (3 zonas balanceadas):
            - Esquerda: Logo + Seletor de Mês
            - Centro (Web): Dock de Navegação Operacional perfeitamente centralizado
            - Direita: Botão exclusivo da Central Admin (separado do menu comum) + Novo Lançamento + Sair */}
        <header className="bg-slate-800/95 border-b border-slate-700/80 px-3.5 sm:px-6 lg:px-8 py-2.5 sm:py-3 sticky top-0 z-20 backdrop-blur-md">
          <div className="max-w-7xl mx-auto flex flex-col gap-2.5">
            {/* Linha Principal com 2 zonas: Esquerda (Logo + Alternador de Mês) e Direita (Admin + Perfil) */}
            <div className="flex items-center justify-between gap-2 sm:gap-4 w-full">
              {/* Zona 1 (Esquerda): Logo + Alternador de Mês */}
              <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                <button
                  type="button"
                  onClick={() => setActiveTab('dashboard')}
                  className="flex items-center gap-2.5 text-left group cursor-pointer shrink-0"
                  title="Ir para o Painel Principal"
                >
                  <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-2xl bg-indigo-600 group-hover:bg-indigo-500 flex items-center justify-center text-white shrink-0 shadow-md shadow-indigo-600/30 transition-colors">
                    <i className="ph-fill ph-wallet text-lg sm:text-xl"></i>
                  </div>
                  <div className="min-w-0">
                    <span className="font-bold text-xs sm:text-sm text-white block truncate max-w-[140px] xl:max-w-none leading-tight">
                      Painel Finanças & Listas
                    </span>
                    <span className="text-[10px] text-slate-400 hidden sm:block leading-tight">
                      Gestão Integrada
                    </span>
                  </div>
                </button>

                {/* Divisor vertical sutil */}
                <div className="hidden sm:block h-6 w-px bg-slate-700/80 shrink-0" />

                {/* Alternador de Mês / Ano ao lado da Logo (Desktop/Tablet) */}
                <div className="hidden sm:flex items-center gap-1 bg-slate-900 border border-slate-700/80 p-1 rounded-2xl shrink-0">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedMonth(addMonthsToYearMonth(selectedMonth, -1))
                    }
                    aria-label="Mês anterior"
                    className="w-7 h-7 rounded-xl hover:bg-slate-800 text-slate-300 hover:text-white flex items-center justify-center cursor-pointer shrink-0 transition-colors"
                  >
                    <i className="ph-bold ph-caret-left text-xs"></i>
                  </button>

                  <div className="px-2 text-center min-w-[104px]">
                    <span className="text-xs font-bold text-white whitespace-nowrap block leading-tight">
                      {formatMonthYearPt(selectedMonth)}
                    </span>
                    <span className="text-[9px] text-slate-400 font-mono block leading-tight">
                      {selectedMonth}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      setSelectedMonth(addMonthsToYearMonth(selectedMonth, 1))
                    }
                    aria-label="Próximo mês"
                    className="w-7 h-7 rounded-xl hover:bg-slate-800 text-slate-300 hover:text-white flex items-center justify-center cursor-pointer shrink-0 transition-colors"
                  >
                    <i className="ph-bold ph-caret-right text-xs"></i>
                  </button>
                </div>
              </div>

              {/* Zona 2 (Direita): Perfil do Usuário com Menu de Configurações */}
              <div className="flex items-center justify-end gap-2 shrink-0">
                {userIsAdmin && (
                  <button
                    type="button"
                    onClick={() => setActiveTab('admin')}
                    title="Abrir Central Administrativa Unificada"
                    className={`px-3 py-2 sm:py-2.5 rounded-2xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap border ${
                      activeTab === 'admin'
                        ? 'bg-amber-500 text-slate-950 border-amber-400 shadow-lg shadow-amber-500/20'
                        : 'bg-slate-900 hover:bg-slate-800 text-amber-300 border-amber-500/35 hover:border-amber-400/60'
                    }`}
                  >
                    <i className="ph-fill ph-shield-check text-sm shrink-0"></i>
                    <span className="hidden sm:inline">Admin</span>
                    {adminUsers.length > 0 && (
                      <span
                        className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-extrabold ${
                          activeTab === 'admin'
                            ? 'bg-slate-950/20 text-slate-950'
                            : 'bg-amber-500/20 text-amber-300'
                        }`}
                      >
                        {adminUsers.length}
                      </span>
                    )}
                  </button>
                )}

                {/* Menu de Perfil e Configurações */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setUserDropdownOpen(!userDropdownOpen)}
                    aria-label="Abrir menu do perfil e configurações"
                    className="flex items-center gap-2 p-1.5 sm:px-3 sm:py-1.5 rounded-2xl bg-slate-900 hover:bg-slate-800 border border-slate-700/80 hover:border-indigo-500/50 text-slate-200 transition-all cursor-pointer group"
                  >
                    <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white font-bold text-xs flex items-center justify-center shrink-0 shadow-sm">
                      {currentUser.name
                        ? currentUser.name
                            .split(' ')
                            .map((p) => p[0])
                            .slice(0, 2)
                            .join('')
                            .toUpperCase()
                        : 'U'}
                    </div>
                    <div className="hidden sm:block text-left min-w-0 max-w-[120px] lg:max-w-[150px]">
                      <span className="text-xs font-bold text-white block truncate leading-tight">
                        {currentUser.name || 'Usuário'}
                      </span>
                      <span className="text-[10px] text-slate-400 block truncate leading-tight">
                        {userIsAdmin ? 'Administrador' : 'Membro'}
                      </span>
                    </div>
                    <i
                      className={`ph-bold ph-caret-down text-xs text-slate-400 group-hover:text-indigo-400 transition-transform ${
                        userDropdownOpen ? 'rotate-180' : ''
                      }`}
                    ></i>
                  </button>

                  {/* Dropdown Menu */}
                  {userDropdownOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-30"
                        onClick={() => setUserDropdownOpen(false)}
                      />
                      <div className="absolute right-0 mt-2 w-64 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl z-40 py-2 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150">
                        {/* Header do Menu */}
                        <div className="px-4 py-2.5 border-b border-slate-800">
                          <p className="text-xs font-bold text-white truncate">
                            {currentUser.name}
                          </p>
                          <p className="text-[11px] text-slate-400 truncate">
                            {currentUser.email}
                          </p>
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <span className="px-2 py-0.5 rounded-md bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[10px] font-bold">
                              {userIsAdmin ? 'Administrador' : 'Membro'}
                            </span>
                            {currentUser.isDemo && (
                              <span className="px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-bold">
                                Demonstração
                              </span>
                            )}
                          </div>
                          <div className="mt-2 flex items-center justify-between text-[10px] text-slate-400 bg-slate-950/60 px-2 py-1 rounded-lg border border-slate-800">
                            <span className="font-mono truncate" title={currentUser.uid}>
                              UID: {currentUser.uid.slice(0, 12)}...
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(currentUser.uid);
                                showToast('UID copiado com sucesso!');
                              }}
                              className="text-slate-400 hover:text-indigo-400 cursor-pointer ml-1 p-0.5"
                              title="Copiar UID canônico para a área de transferência"
                            >
                              <i className="ph ph-copy"></i>
                            </button>
                          </div>
                        </div>

                        {/* Itens do Menu */}
                        <div className="p-1 space-y-0.5">
                          <button
                            type="button"
                            onClick={() => {
                              setUserDropdownOpen(false);
                              setSettingsModalTab('account');
                              setIsSettingsModalOpen(true);
                            }}
                            className="w-full px-3 py-2 rounded-xl text-left text-xs font-semibold text-slate-300 hover:text-white hover:bg-slate-800 flex items-center gap-2.5 cursor-pointer transition-colors"
                          >
                            <i className="ph-bold ph-user-circle text-base text-indigo-400"></i>
                            <span>Minha Conta</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setUserDropdownOpen(false);
                              setSettingsModalTab('finance_categories');
                              setIsSettingsModalOpen(true);
                            }}
                            className="w-full px-3 py-2 rounded-xl text-left text-xs font-semibold text-slate-300 hover:text-white hover:bg-slate-800 flex items-center gap-2.5 cursor-pointer transition-colors"
                          >
                            <i className="ph-bold ph-tag text-base text-emerald-400"></i>
                            <span>Categorias de Finanças</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setUserDropdownOpen(false);
                              setSettingsModalTab('product_categories');
                              setIsSettingsModalOpen(true);
                            }}
                            className="w-full px-3 py-2 rounded-xl text-left text-xs font-semibold text-slate-300 hover:text-white hover:bg-slate-800 flex items-center gap-2.5 cursor-pointer transition-colors"
                          >
                            <i className="ph-bold ph-squares-four text-base text-amber-400"></i>
                            <span>Categorias de Produtos</span>
                          </button>

                          {userIsAdmin && (
                            <button
                              type="button"
                              onClick={() => {
                                setUserDropdownOpen(false);
                                setActiveTab('admin');
                              }}
                              className="w-full px-3 py-2 rounded-xl text-left text-xs font-semibold text-amber-300 hover:text-amber-200 hover:bg-amber-500/10 flex items-center gap-2.5 cursor-pointer transition-colors"
                            >
                              <i className="ph-bold ph-shield-check text-base text-amber-400"></i>
                              <span>Painel Administrativo</span>
                            </button>
                          )}
                        </div>

                        {/* Divisor & Sair */}
                        <div className="pt-1 mt-1 border-t border-slate-800 p-1">
                          <button
                            type="button"
                            onClick={() => {
                              setUserDropdownOpen(false);
                              handleLogout();
                            }}
                            className="w-full px-3 py-2 rounded-xl text-left text-xs font-semibold text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 flex items-center gap-2.5 cursor-pointer transition-colors"
                          >
                            <i className="ph-bold ph-sign-out text-base"></i>
                            <span>Sair da Conta</span>
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Linha compacta de alternância de Mês exclusiva para telas pequenas (< sm) para não espremer a logo */}
            <div className="flex sm:hidden items-center justify-between gap-1.5 bg-slate-900 border border-slate-700/80 p-1 rounded-2xl w-full">
              <button
                type="button"
                onClick={() =>
                  setSelectedMonth(addMonthsToYearMonth(selectedMonth, -1))
                }
                aria-label="Mês anterior (Mobile)"
                className="w-8 h-8 rounded-xl bg-slate-800/80 hover:bg-slate-800 text-slate-200 flex items-center justify-center cursor-pointer shrink-0"
              >
                <i className="ph-bold ph-caret-left text-xs"></i>
              </button>

              <div className="px-2 text-center flex-1">
                <span className="text-xs font-bold text-white whitespace-nowrap">
                  {formatMonthYearPt(selectedMonth)}
                </span>
                <span className="text-[10px] text-slate-400 font-mono ml-1.5">
                  ({selectedMonth})
                </span>
              </div>

              <button
                type="button"
                onClick={() =>
                  setSelectedMonth(addMonthsToYearMonth(selectedMonth, 1))
                }
                aria-label="Próximo mês (Mobile)"
                className="w-8 h-8 rounded-xl bg-slate-800/80 hover:bg-slate-800 text-slate-200 flex items-center justify-center cursor-pointer shrink-0"
              >
                <i className="ph-bold ph-caret-right text-xs"></i>
              </button>
            </div>
          </div>
        </header>

        {/* Aviso quando a API Cloud Firestore ainda não foi ativada no projeto teste-beta-fin-e-list */}
        {cloudStatus === 'api_disabled_or_offline' &&
          !currentUser.isDemo &&
          !cloudBannerDismissed && (
            <div className="mx-3.5 sm:mx-8 mt-3 p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 max-w-7xl lg:mx-auto w-auto">
              <div className="flex items-start sm:items-center gap-2.5 min-w-0">
                <i className="ph-fill ph-database text-amber-400 text-lg shrink-0 mt-0.5 sm:mt-0"></i>
                <div className="leading-relaxed">
                  <span className="font-bold text-amber-300">
                    Cloud Firestore pendente de ativação em{' '}
                    <code className="font-mono">teste-beta-fin-e-list</code>:
                  </span>{' '}
                  O Firebase Auth já está conectado, mas o banco Firestore ainda
                  não foi inicializado no Console do projeto. Enquanto você não
                  clicar em <strong>Criar banco de dados</strong> no Firebase
                  Console (aba <em>Firestore Database</em>), seus lançamentos
                  continuam funcionando normalmente em modo local.
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                <a
                  href="https://console.firebase.google.com/project/teste-beta-fin-e-list/firestore"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-[11px] whitespace-nowrap transition-colors"
                >
                  Abrir Firestore no Console
                </a>
                <button
                  type="button"
                  onClick={() => setCloudBannerDismissed(true)}
                  className="px-2 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white cursor-pointer text-[11px]"
                  title="Ocultar aviso"
                >
                  Ocultar
                </button>
              </div>
            </div>
          )}

        {/* Notificação Toast */}
        {toastMsg && (
          <div
            role="status"
            className="mx-3.5 sm:mx-8 mt-4 p-3.5 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-200 text-xs flex items-center justify-between gap-2 max-w-7xl lg:mx-auto w-auto"
          >
            <div className="flex items-center gap-2 min-w-0">
              <i className="ph-fill ph-check-circle text-emerald-400 text-base shrink-0"></i>
              <span className="break-words">{toastMsg}</span>
            </div>
            <button
              type="button"
              onClick={() => setToastMsg(null)}
              className="text-slate-400 hover:text-white cursor-pointer shrink-0"
            >
              <i className="ph-bold ph-x"></i>
            </button>
          </div>
        )}

        {/* Conteúdo Principal Dinâmico (Padding inferior seguro e responsivo para garantir isolamento e folga total sobre o dock flutuante e o FAB) */}
        <main className="flex-1 px-3.5 sm:px-6 md:px-8 pt-3.5 sm:pt-6 md:pt-8 pb-36 sm:pb-36 md:pb-40 max-w-7xl w-full mx-auto min-w-0">
          {activeTab === 'admin' && userIsAdmin && (
            <AdminDashboardView
              users={adminUsers}
              accounts={adminAccounts}
              categories={adminCategories}
              spaces={adminSpaces}
              transactions={adminTransactions}
              currentUser={currentUser}
              onSwitchToPersonalView={() => setActiveTab('dashboard')}
              onInspectAcquisitionWorkspace={(wsId) => {
                setInspectAcqWorkspaceId(wsId);
                setActiveTab('acquisitions');
              }}
            />
          )}

          {activeTab === 'dashboard' && (
            <DashboardView
              transactions={transactions}
              spaces={spaces}
              selectedMonth={selectedMonth}
              userName={currentUser.name}
              userEmail={currentUser.email}
              userIsAdmin={userIsAdmin}
              activeScope={dashboardScope}
              onChangeScope={setDashboardScope}
              onOpenNewTransaction={(spaceId) => {
                setEditingTx(null);
                setPresetAccountId(undefined);
                setPresetSpaceId(spaceId);
                setIsTxModalOpen(true);
              }}
              onOpenSpaceLedger={(space) => {
                setActiveTab('spaces');
                setActiveLedgerSpace(space);
              }}
              onSelectTransaction={(tx) => setDetailTx(tx)}
              acquisitionLists={acqLists}
              acquisitionItems={acqItems}
              onNavigateToLists={(spaceId) => {
                if (spaceId) setInspectAcqWorkspaceId(spaceId);
                setActiveTab('acquisitions');
              }}
            />
          )}

          {activeTab === 'accounts' && (
            <AccountsLedgerViewV3
              userId={currentUser?.uid || 'usr_anonymous'}
              isDemo={!!currentUser?.isDemo}
            />
          )}

          {activeTab === 'transactions' && (
            <PersonalFinanceViewV3
              userId={currentUser?.uid || 'usr_anonymous'}
              isDemo={!!currentUser?.isDemo}
            />
          )}

          {activeTab === 'spaces' && (
            <SharedSpacesViewV3
              userId={currentUser?.uid || 'usr_anonymous'}
              userName={currentUser?.name || 'Usuário'}
              userEmail={currentUser?.email || ''}
              isDemo={!!currentUser?.isDemo}
            />
          )}

          {activeTab === 'acquisitions' && (
            <AcquisitionsModuleView
              sharedUser={currentUser}
              onLogout={handleLogout}
              initialWorkspaceIdToOpen={inspectAcqWorkspaceId}
              onClearInitialWorkspace={() => setInspectAcqWorkspaceId(null)}
              unifiedSpaces={spaces}
              onOpenManageSpaces={() => setActiveTab('spaces')}
              onOpenCreateSpace={(preset) => {
                setCreateSpacePreset(preset);
                setActiveTab('spaces');
              }}
              onCreateExpenseFromPurchase={(payload) => {
                setEditingTx(null);
                setPresetAccountId(undefined);
                setPresetSpaceId(undefined);
                setPresetTxType('expense');
                setPresetDescription(payload.description);
                setPresetAmount(payload.amount);
                setIsTxModalOpen(true);
                showToast(
                  `Dados de "${payload.description}" carregados no formulário de lançamento!`
                );
              }}
            />
          )}

          {activeTab === 'disputes' && (
            <PendingDisputesView
              transactions={transactions}
              spaces={spaces}
              userEmail={currentUser.email}
              dismissedSpaceNotifIds={dismissedSpaceNotifIds}
              onAcceptSplit={handleAcceptSplit}
              onRejectSplit={handleRejectSplit}
              onProposeNewValue={handleProposeNewValue}
              onAcceptSpaceInvite={handleAcceptSpaceInvite}
              onDeclineSpaceInvite={handleDeclineSpaceInvite}
              onDismissSpaceNotif={handleDismissSpaceNotification}
              onClearAllSpaceNotifs={handleDismissAllSpaceNotifications}
            />
          )}

          {/* Espaçador de segurança para impedir sobreposição do menu flutuante e botões de ação em rolagem final */}
          <div className="h-6 sm:h-8" aria-hidden="true" />
        </main>

        {/* Dock Flutuante Inferior de Navegação (Centralizado no Rodapé: apenas ícones no Mobile, texto completo no Desktop) */}
        <nav
          aria-label="Navegação Principal Flutuante"
          className="fixed bottom-3 inset-x-0 sm:bottom-6 z-30 pointer-events-none flex justify-center px-2 sm:px-4"
        >
          <div className="pointer-events-auto bg-slate-900/95 border border-slate-700/80 backdrop-blur-md p-1.5 sm:p-2 rounded-2xl shadow-2xl flex items-center justify-around sm:justify-start gap-1 sm:gap-2 max-w-[calc(100vw-5rem)] sm:max-w-none overflow-x-auto">
            {navItems.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  title={item.label}
                  aria-label={item.label}
                  className={`relative p-2.5 sm:px-3.5 sm:py-2 rounded-xl text-xs font-semibold transition-all flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer ${
                    isActive
                      ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
                  }`}
                >
                  <i
                    className={`${
                      isActive ? 'ph-fill' : 'ph'
                    } ${item.icon} text-lg sm:text-base shrink-0`}
                  ></i>
                  <span className="hidden sm:inline">{item.label}</span>
                  {typeof item.count === 'number' && item.count > 0 && (
                    <span
                      className={`absolute -top-1 -right-1 sm:static sm:top-auto sm:right-auto px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold ${
                        isActive
                          ? 'bg-white/20 text-white'
                          : 'bg-amber-500/20 text-amber-300'
                      }`}
                    >
                      {item.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </nav>
      </div>

      {/* Modal de Detalhe Completo do Lançamento */}
      <TransactionDetailModal
        transaction={
          detailTx
            ? transactions.find((t) => t.id === detailTx.id) || detailTx
            : null
        }
        allTransactions={transactions}
        onClose={() => setDetailTx(null)}
        onEdit={(tx) => {
          setDetailTx(null);
          setEditingTx(tx);
          setIsTxModalOpen(true);
        }}
        onUpdateStatusCascade={handleUpdateStatusCascade}
        onRequestSettleTransaction={(tx) => {
          setDetailTx(null);
          setSettlingTxModal({ tx });
        }}
        onDeleteCascade={handleDeleteCascade}
      />

      {/* Modal de Validação de Valor para Efetivação de Receita ou Pagamento de Despesa */}
      <ConfirmSettlementModal
        isOpen={Boolean(settlingTxModal)}
        transaction={settlingTxModal?.tx || null}
        space={
          settlingTxModal?.tx?.spaceId
            ? spaces.find((s) => s.id === settlingTxModal.tx.spaceId) || null
            : null
        }
        userEmail={currentUser.email}
        defaultSpaceMode={settlingTxModal?.defaultSpaceMode}
        onClose={() => setSettlingTxModal(null)}
        onConfirm={handleConfirmSettlement}
      />

      {/* Formulário Universal (Modal) */}
      <UniversalTransactionModal
        isOpen={isTxModalOpen}
        onClose={() => {
          setIsTxModalOpen(false);
          setEditingTx(null);
          setPresetTxType(undefined);
          setPresetDescription(undefined);
          setPresetAmount(undefined);
        }}
        accounts={accounts}
        categories={categories}
        spaces={spaces}
        userId={currentUser.uid}
        userEmail={currentUser.email}
        userName={currentUser.name}
        selectedMonth={selectedMonth}
        editingTransaction={editingTx}
        presetAccountId={presetAccountId}
        presetSpaceId={presetSpaceId}
        presetType={presetTxType}
        presetDescription={presetDescription}
        presetAmount={presetAmount}
        onSaveSeries={handleSaveTransactionSeries}
        onCreateCategory={handleCreateCategory}
        onNotifyToast={showToast}
      />

      {/* Modal Unificado de Configurações do Sistema e Minha Conta */}
      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        initialTab={settingsModalTab}
        currentUser={currentUser}
        userIsAdmin={userIsAdmin}
        onUpdateUserName={handleUpdateUserName}
        categories={categories}
        onCreateCategory={handleCreateCategory}
        onDeleteCategory={handleDeleteCategory}
        taxonomyGroups={acqTaxonomyGroups}
        onAddTaxonomyGroup={handleAddTaxonomyGroup}
        onUpdateTaxonomyGroup={(groupId, name, _code, description) =>
          handleUpdateTaxonomyGroup(groupId, name, description)
        }
        onDeleteTaxonomyGroup={handleDeleteTaxonomyGroup}
        onAddTaxonomyCategory={handleAddTaxonomyCategory}
        onUpdateTaxonomyCategory={handleUpdateTaxonomyCategory}
        onDeleteTaxonomyCategory={handleDeleteTaxonomyCategory}
        onNotifyToast={showToast}
      />

      {/* Botão de Ação Rápida Flutuante (FAB) no Canto Inferior Direito */}
      <QuickActionFAB
        onOpenNewTransaction={() => {
          setEditingTx(null);
          setPresetAccountId(undefined);
          setPresetSpaceId(undefined);
          setPresetDescription(undefined);
          setPresetAmount(undefined);
          setIsTxModalOpen(true);
        }}
        onOpenNewList={() => {
          setActiveTab('acquisitions');
        }}
        onOpenNewSpace={() => {
          setCreateSpacePreset('both');
          setActiveTab('spaces');
        }}
      />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  );
}

