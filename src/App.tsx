import React, { useEffect, useState } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
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
import { AccountsCardsView } from './components/AccountsCardsView';
import { TransactionsView } from './components/TransactionsView';
import { SpacesLedgerView } from './components/SpacesLedgerView';
import { PendingDisputesView } from './components/PendingDisputesView';
import { UniversalTransactionModal } from './components/UniversalTransactionModal';
import { AdminDashboardView } from './components/AdminDashboardView';
import { TransactionDetailModal } from './components/TransactionDetailModal';
import { ConfirmSettlementModal } from './components/ConfirmSettlementModal';
import { AcquisitionsModuleView } from './components/acquisitions/AcquisitionsModuleView';

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

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [currentUser, setCurrentUser] = useState<{
    uid: string;
    name: string;
    email: string;
    isDemo: boolean;
  } | null>(null);

  // Navegação e App Shell
  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [selectedMonth, setSelectedMonth] = useState('2026-11');
  const [dashboardScope, setDashboardScope] = useState('overview');

  // Dados Financeiros Pessoais (Firestore real-time ou Demo Seed determinístico)
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);

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
  const [activeLedgerSpace, setActiveLedgerSpace] = useState<Space | null>(null);
  const [detailTx, setDetailTx] = useState<Transaction | null>(null);
  const [settlingTxModal, setSettlingTxModal] = useState<{
    tx: Transaction;
    defaultSpaceMode?: 'space_cash' | 'member_direct';
  } | null>(null);
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
      setAuthReady(true);
      return;
    }

    if (autostartMode === '1') {
      const profile = {
        uid: 'demo_keniel_uid',
        name: 'Keniel Calixto',
        email: 'kenielcalixtonkenny@gmail.com',
      };
      enterDemoSession(profile);
      setAuthReady(true);
      return;
    }

    localStorage.removeItem('mpf_active_demo_profile');

    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        const pendingName = sessionStorage.getItem('mpf_pending_signup_name');
        const userIsAdmin = isAdminUid(user.uid);
        setCurrentUser({
          uid: user.uid,
          name:
            user.displayName ||
            pendingName ||
            user.email?.split('@')[0] ||
            'Usuário',
          email: (user.email || 'usuario@email.com').toLowerCase(),
          isDemo: false,
        });
        setActiveTab(userIsAdmin ? 'admin' : 'dashboard');
      } else {
        setCurrentUser(null);
        setActiveTab('dashboard');
      }
      setAuthReady(true);
    });

    return () => unsub();
  }, []);

  const enterDemoSession = (profile: {
    uid: string;
    name: string;
    email: string;
  }) => {
    const seed = getInitialDemoData(profile.uid, profile.email, profile.name);
    setAccounts(seed.accounts);
    setCategories(seed.categories);
    setSpaces(seed.spaces);
    setTransactions(seed.transactions);
    setCurrentUser({
      ...profile,
      isDemo: true,
    });
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

    // Garante dados iniciais imediatos caso o Firestore ainda não esteja ativado no projeto teste-beta-fin-e-list
    setAccounts((prev) => (prev.length === 0 ? seed.accounts : prev));
    setCategories((prev) => (prev.length === 0 ? seed.categories : prev));
    setSpaces((prev) => (prev.length === 0 ? seed.spaces : prev));
    setTransactions((prev) => (prev.length === 0 ? seed.transactions : prev));

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
          setCurrentUser((prev) =>
            prev && prev.name !== String(data.name)
              ? { ...prev, name: String(data.name) }
              : prev
          );
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
        setAccounts(
          snap.docs.map((d) => ({ ...(d.data() as Account), id: d.id }))
        );
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
        setCategories(
          snap.docs.map((d) => ({ ...(d.data() as Category), id: d.id }))
        );
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
        setSpaces(snap.docs.map((d) => ({ ...(d.data() as Space), id: d.id })));
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
        setTransactions(
          snap.docs.map((d) => ({ ...(d.data() as Transaction), id: d.id }))
        );
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
      setAccounts((prev) => [...prev, newAcc]);
      showToast(`Conta/Cartão "${accData.name}" salvo localmente.`);
    }
  };

  const handleUpdateAccount = async (
    accountId: string,
    accData: Omit<Account, 'id' | 'userId'>
  ) => {
    if (!currentUser) return;
    if (currentUser.isDemo) {
      setAccounts((prev) =>
        prev.map((a) => (a.id === accountId ? { ...a, ...accData } : a))
      );
      setTransactions((prev) =>
        prev.map((tx) =>
          tx.accountId === accountId
            ? { ...tx, accountName: accData.name, accountType: accData.type }
            : tx
        )
      );
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
      setAccounts((prev) =>
        prev.map((a) => (a.id === accountId ? { ...a, ...accData } : a))
      );
      setTransactions((prev) =>
        prev.map((tx) =>
          tx.accountId === accountId
            ? { ...tx, accountName: accData.name, accountType: accData.type }
            : tx
        )
      );
      showToast(`Conta/Cartão "${accData.name}" atualizado localmente.`);
    }
  };

  const handleDeleteAccount = async (accountId: string) => {
    if (!currentUser) return;
    if (currentUser.isDemo) {
      setAccounts((prev) => prev.filter((a) => a.id !== accountId));
      showToast('Conta/Cartão excluído com sucesso.');
      return;
    }
    try {
      await deleteDoc(doc(db, 'accounts', accountId));
      showToast('Conta/Cartão excluído do Firestore.');
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `accounts/${accountId}`);
      setAccounts((prev) => prev.filter((a) => a.id !== accountId));
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

    if (currentUser.isDemo) {
      setTransactions((prev) =>
        prev.map((tx) =>
          targetItems.some((t) => t.id === tx.id)
            ? { ...tx, status: 'paid', paymentDate: today }
            : tx
        )
      );
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
      setTransactions((prev) =>
        prev.map((tx) =>
          targetItems.some((t) => t.id === tx.id)
            ? { ...tx, status: 'paid', paymentDate: today }
            : tx
        )
      );
      showToast(`Fatura ${invoiceMonth} do cartão ${card.name} liquidada localmente!`);
    }
  };

  const handleCreateCategory = async (
    catData: Omit<Category, 'id' | 'userId'>
  ): Promise<Category> => {
    const uid = currentUser?.uid || 'demo_uid';
    const id = `cat_${Date.now()}`;
    const newCat: Category = { ...catData, id, userId: uid };

    if (!currentUser || currentUser.isDemo) {
      setCategories((prev) => [...prev, newCat]);
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
      setCategories((prev) => [...prev, newCat]);
      return newCat;
    }
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

      if (currentUser.isDemo) {
        setTransactions((prev) =>
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
      }
      return;
    }

    // Criação de novo lançamento (ou série fixa/parcelada)
    const createdWithIds: Transaction[] = series.map((item, idx) => ({
      ...item,
      id: `tx_${Date.now()}_${idx}`,
    }));

    if (currentUser.isDemo) {
      setTransactions((prev) => [...createdWithIds, ...prev]);
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
      showToast('Lançamento sincronizado com sucesso!');
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, 'transactions');
      setTransactions((prev) => [...createdWithIds, ...prev]);
      showToast('Lançamento registrado localmente com sucesso!');
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

    if (currentUser.isDemo) {
      setTransactions((prev) =>
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

    if (currentUser.isDemo) {
      setTransactions((prev) =>
        prev.filter((item) => !targets.some((t) => t.id === item.id))
      );
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
    };

    if (currentUser.isDemo) {
      setSpaces((prev) => [...prev, newSp]);
      return;
    }

    try {
      await setDoc(doc(db, 'spaces', id), {
        ...spData,
        ownerId: currentUser.uid,
        ownerEmail: currentUser.email,
        createdAt: serverTimestamp(),
      });
      showToast(`Espaço "${spData.name}" criado no Firestore!`);
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, `spaces/${id}`);
    }
  };

  const handleUpdateSpace = async (
    spaceId: string,
    spData: Omit<Space, 'id' | 'ownerId' | 'ownerEmail'>
  ) => {
    if (!currentUser) return;

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

    if (currentUser.isDemo) {
      setTransactions((prev) => [settlementTx, ...prev]);
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

    if (currentUser.isDemo) {
      setTransactions((prev) =>
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
      setSettlingTxModal(null);
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

    if (currentUser.isDemo) {
      setTransactions((prev) =>
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

    if (currentUser.isDemo) {
      setTransactions((prev) =>
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

    if (currentUser.isDemo) {
      setTransactions((prev) =>
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
    localStorage.removeItem('mpf_active_demo_profile');
    if (currentUser && !currentUser.isDemo) {
      await signOut(auth);
    }
    setCurrentUser(null);
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-slate-400 text-sm">
        Carregando Meu Painel Financeiro...
      </div>
    );
  }

  if (!currentUser) {
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
      id: 'dashboard',
      label: 'Painel',
      shortLabel: 'Painel',
      icon: 'ph-chart-pie-slice',
    },
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
      label: 'Aquisições',
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
            {/* Linha Principal com Grid de 3 colunas no Desktop (lg:grid-cols-[1fr_auto_1fr]) para manter o menu centralizado */}
            <div className="flex items-center justify-between lg:grid lg:grid-cols-[1fr_auto_1fr] gap-2 sm:gap-4 w-full">
              {/* Zona 1 (Esquerda): Logo + Alternador de Mês */}
              <div className="flex items-center gap-2 sm:gap-3 min-w-0 justify-self-start">
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

              {/* Zona 2 (Centro - Desktop): Dock de Navegação Principal perfeitamente alinhado ao centro */}
              <nav
                aria-label="Navegação Principal"
                className="hidden md:flex items-center justify-center gap-1 bg-slate-900/95 border border-slate-700/80 p-1.5 rounded-2xl justify-self-center shadow-inner"
              >
                {navItems.map((item) => {
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setActiveTab(item.id)}
                      className={`px-3 lg:px-3.5 py-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-2 whitespace-nowrap cursor-pointer ${
                        isActive
                          ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/25'
                          : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
                      }`}
                    >
                      <i
                        className={`${
                          isActive ? 'ph-fill' : 'ph'
                        } ${item.icon} text-base shrink-0`}
                      ></i>
                      <span className="hidden xl:inline">{item.label}</span>
                      <span className="xl:hidden">{item.shortLabel}</span>
                      {typeof item.count === 'number' && item.count > 0 && (
                        <span
                          className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold ${
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
              </nav>

              {/* Zona 3 (Direita): Botão Separado de Admin + Novo Lançamento + Sair */}
              <div className="flex items-center justify-end gap-2 shrink-0 justify-self-end">
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

                <button
                  type="button"
                  onClick={() => {
                    setEditingTx(null);
                    setPresetAccountId(undefined);
                    setPresetSpaceId(undefined);
                    setPresetDescription(undefined);
                    setPresetAmount(undefined);
                    setIsTxModalOpen(true);
                  }}
                  className="px-3.5 sm:px-4 py-2 sm:py-2.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-lg shadow-indigo-600/25 flex items-center gap-1.5 sm:gap-2 cursor-pointer whitespace-nowrap active:scale-95 transition-all"
                >
                  <i className="ph-bold ph-plus text-sm"></i>
                  <span className="sm:hidden">Lançar</span>
                  <span className="hidden sm:inline">Novo Lançamento</span>
                </button>

                <button
                  type="button"
                  onClick={handleLogout}
                  aria-label="Sair da conta"
                  title="Sair da conta"
                  className="w-9 h-9 sm:w-10 sm:h-10 rounded-2xl bg-slate-900 hover:bg-rose-500/15 border border-slate-700/80 hover:border-rose-500/40 text-slate-400 hover:text-rose-300 flex items-center justify-center transition-colors cursor-pointer shrink-0"
                >
                  <i className="ph-bold ph-sign-out text-base"></i>
                </button>
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

        {/* Conteúdo Principal Dinâmico (pb-28 no mobile garante folga extra para o menu inferior nunca sobrepor conteúdos) */}
        <main className="flex-1 p-3.5 sm:p-6 md:p-8 pb-28 md:pb-8 max-w-7xl w-full mx-auto min-w-0">
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
            />
          )}

          {activeTab === 'accounts' && (
            <AccountsCardsView
              accounts={accounts}
              transactions={transactions}
              selectedMonth={selectedMonth}
              onCreateAccount={handleCreateAccount}
              onUpdateAccount={handleUpdateAccount}
              onDeleteAccount={handleDeleteAccount}
              onPayInvoice={handlePayInvoice}
              onOpenNewTransactionForAccount={(accId) => {
                setEditingTx(null);
                setPresetAccountId(accId);
                setPresetSpaceId(undefined);
                setIsTxModalOpen(true);
              }}
              onSelectTransaction={(tx) => setDetailTx(tx)}
            />
          )}

          {activeTab === 'transactions' && (
            <TransactionsView
              transactions={transactions}
              selectedMonth={selectedMonth}
              onOpenNewModal={() => {
                setEditingTx(null);
                setPresetAccountId(undefined);
                setPresetSpaceId(undefined);
                setIsTxModalOpen(true);
              }}
              onEditTransaction={(tx) => {
                setEditingTx(tx);
                setIsTxModalOpen(true);
              }}
              onSelectTransaction={(tx) => setDetailTx(tx)}
              onUpdateStatusCascade={handleUpdateStatusCascade}
              onRequestSettleTransaction={(tx) => setSettlingTxModal({ tx })}
              onDeleteCascade={handleDeleteCascade}
            />
          )}

          {activeTab === 'spaces' && (
            <SpacesLedgerView
              spaces={spaces}
              transactions={transactions}
              selectedMonth={selectedMonth}
              onChangeMonth={setSelectedMonth}
              userEmail={currentUser.email}
              userName={currentUser.name}
              activeLedgerSpace={activeLedgerSpace}
              onSetActiveLedgerSpace={setActiveLedgerSpace}
              onCreateSpace={handleCreateSpace}
              onUpdateSpace={handleUpdateSpace}
              onDeleteSpace={handleDeleteSpace}
              onInviteToSpace={handleInviteToSpace}
              onSettleTransfer={handleSettleTransfer}
              onConfirmSpaceIncome={handleConfirmSpaceIncome}
              onSettleSpaceExpense={handleSettleSpaceExpense}
              onOpenNewTransactionInSpace={(spId, pType) => {
                setEditingTx(null);
                setPresetAccountId(undefined);
                setPresetSpaceId(spId);
                setPresetTxType(pType);
                setIsTxModalOpen(true);
              }}
              onSelectTransaction={(tx) => setDetailTx(tx)}
              onNotifyToast={showToast}
            />
          )}

          {activeTab === 'acquisitions' && (
            <AcquisitionsModuleView
              sharedUser={currentUser}
              onLogout={handleLogout}
              initialWorkspaceIdToOpen={inspectAcqWorkspaceId}
              onClearInitialWorkspace={() => setInspectAcqWorkspaceId(null)}
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
        </main>

        {/* Barra de Navegação Inferior Fixa Exclusiva para Celular (Com suporte a safe-area para não sobrepor) */}
        <nav
          aria-label="Navegação Rápida Mobile"
          className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-slate-900/95 border-t border-slate-700/90 backdrop-blur-md px-1.5 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex items-center justify-around shadow-2xl"
        >
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`relative flex-1 min-w-0 py-1.5 px-1 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
                  isActive
                    ? 'text-indigo-400 font-bold bg-indigo-500/10'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <div className="relative flex items-center justify-center">
                  <i
                    className={`${
                      isActive ? 'ph-fill' : 'ph'
                    } ${item.icon} text-lg`}
                  ></i>
                  {typeof item.count === 'number' && item.count > 0 && (
                    <span className="absolute -top-1.5 -right-3 px-1 min-w-[16px] h-4 rounded-full bg-amber-500 text-slate-950 font-mono text-[10px] font-extrabold flex items-center justify-center">
                      {item.count}
                    </span>
                  )}
                </div>
                <span className="text-[10px] leading-tight truncate max-w-full">
                  {item.shortLabel}
                </span>
              </button>
            );
          })}
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
    </div>
  );
}
