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
  calculateGoalFinalReport,
  calculateGoalProgress,
  calculatePriceStats,
  formatCurrencyBRL,
  getNextStage,
  getPreviousStage,
  getStagesForListType,
  isStockCritical,
} from '../../utils/stateMachine';
import { ResponsiveSheetModal } from './ResponsiveSheetModal';
import { uploadFileToFirebaseStorage } from '../../services/acquisitionsFirebase';
import {
  ArrowLeft,
  ArrowRight,
  CornerUpLeft,
  ExternalLink,
  History,
  PiggyBank,
  Plus,
  Minus,
  RotateCcw,
  ShoppingCart,
  Sparkles,
  Upload,
  Users,
  AlertTriangle,
  CheckCircle2,
  Link2,
  Edit3,
  Trash2,
  Layers,
  PackageCheck,
  Filter,
} from 'lucide-react';

interface WorkspaceBoardViewProps {
  workspace: Workspace;
  lists: AcquisitionList[];
  items: AcquisitionItem[];
  taxonomyGroups: TaxonomyGroup[];
  currentUser: UserProfile;
  openCreateListTrigger?: number;
  onBackToHub: () => void;
  onUpdateWorkspace: (
    workspaceId: string,
    name: string,
    description: string,
    type: 'Individual' | 'Compartilhado',
    budget: number
  ) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onInviteMembers: (workspaceId: string, emails: string[]) => void;
  onUpdateMemberStatus: (
    workspaceId: string,
    email: string,
    status: 'Pendente' | 'Aceito' | 'Recusado'
  ) => void;
  onRemoveMember: (workspaceId: string, email: string) => void;
  onCreateList: (workspaceId: string, name: string, type: ListType, description: string) => void | Promise<void>;
  onUpdateList: (listId: string, name: string, type: ListType, description: string) => void | Promise<void>;
  onDeleteList: (listId: string) => void | Promise<void>;
  onCreateItem: (newItem: Omit<AcquisitionItem, 'id' | 'updatedAt' | 'productsHistory'>) => void | Promise<void>;
  onUpdateItem: (updatedItem: AcquisitionItem) => void | Promise<void>;
  onDeleteItem: (itemId: string) => void | Promise<void>;
  onMoveItemStage: (item: AcquisitionItem, targetStage: ItemStage) => void | Promise<void>;
  onConfirmCartCheckout: (
    item: AcquisitionItem,
    productInput: {
      brand: string;
      unitPrice: number;
      quantity: number;
      storeName: string;
      receiptUrl?: string;
    },
    advanceToConfirmed: boolean
  ) => void | Promise<void>;
  onAddGoalDeposit: (item: AcquisitionItem, amount: number, note: string) => void | Promise<void>;
  onAddGoalQuote: (item: AcquisitionItem, quote: Omit<GoalQuote, 'id' | 'recordedAt'>) => void | Promise<void>;
  onDeleteGoalQuote: (item: AcquisitionItem, quoteId: string) => void | Promise<void>;
  onCompleteGoalAcquisition: (
    item: AcquisitionItem,
    finalPaidAmount: number,
    storeName: string,
    brand: string,
    receiptUrl?: string
  ) => void | Promise<void>;
  onConvertWishToGoal: (wishItem: AcquisitionItem, targetGoalListId: string) => void | Promise<void>;
  onAdjustItemStock: (item: AcquisitionItem, delta: number, autoMoveToBuyOnCritical: boolean) => void | Promise<void>;
  onReturnConfirmedToStock: (item: AcquisitionItem) => void | Promise<void>;
  onCreateExpenseFromPurchase?: (payload: {
    description: string;
    amount: number;
    storeName?: string;
  }) => void;
}

const LIST_TYPE_BUTTONS: { id: ListType; label: string }[] = [
  { id: 'recorrente', label: 'Recorrente' },
  { id: 'objetivo', label: 'Objetivo' },
  { id: 'desejo', label: 'Desejo' },
];

export const WorkspaceBoardView: React.FC<WorkspaceBoardViewProps> = ({
  workspace,
  lists,
  items,
  taxonomyGroups,
  currentUser,
  openCreateListTrigger,
  onBackToHub,
  onUpdateWorkspace,
  onDeleteWorkspace,
  onInviteMembers,
  onUpdateMemberStatus,
  onRemoveMember,
  onCreateList,
  onUpdateList,
  onDeleteList,
  onCreateItem,
  onUpdateItem,
  onDeleteItem,
  onMoveItemStage,
  onConfirmCartCheckout,
  onAddGoalDeposit,
  onAddGoalQuote,
  onDeleteGoalQuote,
  onCompleteGoalAcquisition,
  onConvertWishToGoal,
  onAdjustItemStock,
  onReturnConfirmedToStock,
  onCreateExpenseFromPurchase,
}) => {
  const isPersonalVirtualWs = workspace.id.startsWith('ws_personal_');
  const workspaceLists = lists.filter((l) => l.workspaceId === workspace.id);
  const [selectedListId, setSelectedListId] = useState<string>(
    workspaceLists[0]?.id || ''
  );

  const activeList =
    workspaceLists.find((l) => l.id === selectedListId) || workspaceLists[0];

  const stages = activeList ? getStagesForListType(activeList.type) : [];
  const [activeMobileStage, setActiveMobileStage] = useState<ItemStage>(
    (stages[0]?.id as ItemStage) || 'estoque'
  );

  useEffect(() => {
    const first = workspaceLists[0];
    if (!first) {
      setSelectedListId('');
      return;
    }
    if (!workspaceLists.some((l) => l.id === selectedListId)) {
      setSelectedListId(first.id);
      const listStages = getStagesForListType(first.type);
      if (listStages.length > 0) {
        setActiveMobileStage(listStages[0].id as ItemStage);
      }
    }
  }, [workspace.id, workspaceLists, selectedListId]);

  useEffect(() => {
    if (openCreateListTrigger && openCreateListTrigger > 0) {
      setIsNewListModalOpen(true);
    }
  }, [openCreateListTrigger]);

  // Sync mobile stage tab when switching list type
  const handleSelectList = (list: AcquisitionList) => {
    setSelectedListId(list.id);
    const listStages = getStagesForListType(list.type);
    if (listStages.length > 0) {
      setActiveMobileStage(listStages[0].id as ItemStage);
    }
  };

  // Workspace Edit / Delete Modal states
  const [isEditWorkspaceOpen, setIsEditWorkspaceOpen] = useState(false);
  const [editWsName, setEditWsName] = useState(workspace.name);
  const [editWsDesc, setEditWsDesc] = useState(workspace.description);
  const [editWsType, setEditWsType] = useState<'Individual' | 'Compartilhado'>(
    workspace.type
  );
  const [editWsBudget, setEditWsBudget] = useState(
    String(workspace.monthlyBudget ?? 0)
  );
  const [isDeleteWorkspaceOpen, setIsDeleteWorkspaceOpen] = useState(false);

  // Members Modal state
  const [isMembersModalOpen, setIsMembersModalOpen] = useState(false);
  const [inviteEmailsInput, setInviteEmailsInput] = useState('');
  const [inviteSuccessMsg, setInviteSuccessMsg] = useState('');

  // List Create / Edit / Delete Modal states
  const [isNewListModalOpen, setIsNewListModalOpen] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [newListType, setNewListType] = useState<ListType>('recorrente');
  const [newListDesc, setNewListDesc] = useState('');

  const [editingList, setEditingList] = useState<AcquisitionList | null>(null);
  const [editListName, setEditListName] = useState('');
  const [editListType, setEditListType] = useState<ListType>('recorrente');
  const [editListDesc, setEditListDesc] = useState('');

  const [deletingList, setDeletingList] = useState<AcquisitionList | null>(null);

  // Item Create / Edit / Delete Modal states
  const [isNewItemModalOpen, setIsNewItemModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<AcquisitionItem | null>(null);
  const [deletingItem, setDeletingItem] = useState<AcquisitionItem | null>(null);

  const [itemName, setItemName] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState(
    taxonomyGroups[0]?.id || ''
  );
  const availableCategories =
    taxonomyGroups.find((g) => g.id === selectedGroupId)?.categories || [];
  const [selectedCategoryId, setSelectedCategoryId] = useState(
    availableCategories[0]?.id || ''
  );
  const [itemNotes, setItemNotes] = useState('');
  const [currentStockInput, setCurrentStockInput] = useState('1');
  const [minStockInput, setMinStockInput] = useState('2');
  const [unitInput, setUnitInput] = useState('un');
  const [targetAmountInput, setTargetAmountInput] = useState('2500');
  const [estimatedPriceInput, setEstimatedPriceInput] = useState('1200');
  const [priorityInput, setPriorityInput] = useState<'Baixa' | 'Média' | 'Alta'>('Alta');
  const [inspirationUrlInput, setInspirationUrlInput] = useState('');
  const [prosConsInput, setProsConsInput] = useState('');

  // Modal: Recurring Cart Product Instance
  const [cartModalState, setCartModalState] = useState<{
    item: AcquisitionItem;
    advanceToConfirmed: boolean;
  } | null>(null);
  const [prodBrand, setProdBrand] = useState('');
  const [prodPrice, setProdPrice] = useState('');
  const [prodQty, setProdQty] = useState('1');
  const [prodStore, setProdStore] = useState('');
  const [prodReceiptUrl, setProdReceiptUrl] = useState('');
  const [isUploadingReceipt, setIsUploadingReceipt] = useState(false);
  const [createExpenseOnCartConfirm, setCreateExpenseOnCartConfirm] = useState(false);

  // Modal: Product History Viewer
  const [historyModalItem, setHistoryModalItem] = useState<AcquisitionItem | null>(
    null
  );

  // Modal: Goal Deposit
  const [depositModalItem, setDepositModalItem] = useState<AcquisitionItem | null>(
    null
  );
  const [depositAmount, setDepositAmount] = useState('300');
  const [depositNote, setDepositNote] = useState('');

  // Modal: Goal Quote / Link
  const [quoteModalItem, setQuoteModalItem] = useState<AcquisitionItem | null>(
    null
  );
  const [quoteStore, setQuoteStore] = useState('');
  const [quoteUrl, setQuoteUrl] = useState('');
  const [quotePrice, setQuotePrice] = useState('');
  const [quoteNotes, setQuoteNotes] = useState('');

  // Modal: Goal Final Acquisition Report
  const [acquireGoalModalItem, setAcquireGoalModalItem] =
    useState<AcquisitionItem | null>(null);
  const [finalPaidInput, setFinalPaidInput] = useState('');
  const [finalStoreInput, setFinalStoreInput] = useState('');
  const [finalBrandInput, setFinalBrandInput] = useState('');
  const [createExpenseOnGoalComplete, setCreateExpenseOnGoalComplete] = useState(false);

  // Modal: Convert Wish to Goal
  const [convertWishModalItem, setConvertWishModalItem] =
    useState<AcquisitionItem | null>(null);
  const goalListsInWorkspace = workspaceLists.filter((l) => l.type === 'objetivo');
  const [targetGoalListId, setTargetGoalListId] = useState(
    goalListsInWorkspace[0]?.id || ''
  );

  // Board UX toggles: group by category, focus cart items, bought/confirmed panel
  const [groupByCategory, setGroupByCategory] = useState(false);
  const [showOnlyCart, setShowOnlyCart] = useState(false);
  const [showBoughtPanel, setShowBoughtPanel] = useState(true);

  // Handlers
  const handleGroupSelectChange = (newGroupId: string) => {
    setSelectedGroupId(newGroupId);
    const grp = taxonomyGroups.find((g) => g.id === newGroupId);
    setSelectedCategoryId(grp?.categories[0]?.id || '');
  };

  const openNewItemModal = () => {
    setEditingItem(null);
    setItemName('');
    const defaultGrp = taxonomyGroups[0]?.id || '';
    setSelectedGroupId(defaultGrp);
    setSelectedCategoryId(taxonomyGroups[0]?.categories[0]?.id || '');
    setItemNotes('');
    setCurrentStockInput('1');
    setMinStockInput('2');
    setUnitInput('un');
    setTargetAmountInput('2500');
    setEstimatedPriceInput('1200');
    setPriorityInput('Alta');
    setInspirationUrlInput('');
    setProsConsInput('');
    setIsNewItemModalOpen(true);
  };

  const openEditItemModal = (item: AcquisitionItem) => {
    setEditingItem(item);
    setItemName(item.name);
    setSelectedGroupId(item.groupId);
    setSelectedCategoryId(item.categoryId);
    setItemNotes(item.notes || '');
    setCurrentStockInput(String(item.currentStock ?? 1));
    setMinStockInput(String(item.minStock ?? 2));
    setUnitInput(item.unit || 'un');
    setTargetAmountInput(String(item.targetAmount ?? 2500));
    setEstimatedPriceInput(String(item.estimatedPrice ?? 1200));
    setPriorityInput(item.priority || 'Alta');
    setInspirationUrlInput(item.inspirationUrl || '');
    setProsConsInput(item.prosAndCons || '');
    setIsNewItemModalOpen(true);
  };

  const openEditListModal = (list: AcquisitionList) => {
    setEditingList(list);
    setEditListName(list.name);
    setEditListType(list.type);
    setEditListDesc(list.description);
  };

  const handleEditWorkspaceSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editWsName.trim()) return;
    onUpdateWorkspace(
      workspace.id,
      editWsName.trim(),
      editWsDesc.trim(),
      editWsType,
      Number(editWsBudget) || 0
    );
    setIsEditWorkspaceOpen(false);
  };

  const handleEditListSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingList || !editListName.trim()) return;
    onUpdateList(
      editingList.id,
      editListName.trim(),
      editListType,
      editListDesc.trim()
    );
    setEditingList(null);
  };

  const handleConfirmDeleteList = () => {
    if (!deletingList) return;
    onDeleteList(deletingList.id);
    setDeletingList(null);
  };

  const handleOpenCartProductModal = (
    item: AcquisitionItem,
    advanceToConfirmed: boolean
  ) => {
    setProdBrand(item.cartDraft?.brand || item.productsHistory?.[0]?.brand || '');
    setProdPrice(
      String(item.cartDraft?.unitPrice || item.productsHistory?.[0]?.unitPrice || '')
    );
    setProdQty(String(item.cartDraft?.quantity || 1));
    setProdStore(
      item.cartDraft?.storeName || item.productsHistory?.[0]?.storeName || ''
    );
    setProdReceiptUrl(item.cartDraft?.receiptUrl || '');
    setCartModalState({ item, advanceToConfirmed });
  };

  const handleAdvanceClick = (item: AcquisitionItem) => {
    const next = getNextStage(item.listType, item.stage);
    if (!next) return;

    if (item.listType === 'recorrente' && next === 'carrinho') {
      handleOpenCartProductModal(item, false);
      return;
    }
    if (item.listType === 'recorrente' && next === 'conferido') {
      handleOpenCartProductModal(item, true);
      return;
    }
    if (item.listType === 'objetivo' && next === 'adquirido') {
      setAcquireGoalModalItem(item);
      setFinalPaidInput(String(item.targetAmount || item.savedAmount || 0));
      setFinalStoreInput(item.quotes?.[0]?.storeName || '');
      setFinalBrandInput('');
      return;
    }

    onMoveItemStage(item, next);
  };

  const handleRevertClick = (item: AcquisitionItem) => {
    const prev = getPreviousStage(item.listType, item.stage);
    if (!prev) return;
    onMoveItemStage(item, prev);
  };

  const handleInviteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const emails = inviteEmailsInput
      .split(/[,;\n]+/)
      .map((em) => em.trim().toLowerCase())
      .filter((em) => em.includes('@'));
    if (emails.length === 0) return;

    onInviteMembers(workspace.id, emails);
    setInviteEmailsInput('');
    setInviteSuccessMsg(`${emails.length} convite(s) enviado(s) com status Pendente.`);
  };

  const handleCreateListSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newListName.trim()) return;
    onCreateList(
      workspace.id,
      newListName.trim(),
      newListType,
      newListDesc.trim() || `Fluxo ${newListType} do espaço.`
    );
    setNewListName('');
    setNewListDesc('');
    setIsNewListModalOpen(false);
  };

  const handleSaveItemSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeList || !itemName.trim()) return;

    const validCatId =
      selectedCategoryId ||
      taxonomyGroups.find((g) => g.id === selectedGroupId)?.categories[0]?.id ||
      '';

    if (editingItem) {
      const updatedItem: AcquisitionItem = {
        ...editingItem,
        name: itemName.trim(),
        groupId: selectedGroupId,
        categoryId: validCatId,
        notes: itemNotes.trim(),
        currentStock:
          editingItem.listType === 'recorrente'
            ? Number(currentStockInput) || 0
            : editingItem.currentStock,
        minStock:
          editingItem.listType === 'recorrente'
            ? Number(minStockInput) || 1
            : editingItem.minStock,
        unit:
          editingItem.listType === 'recorrente' ? unitInput : editingItem.unit,
        targetAmount:
          editingItem.listType === 'objetivo'
            ? Number(targetAmountInput) || 1000
            : editingItem.targetAmount,
        estimatedPrice:
          editingItem.listType === 'desejo'
            ? Number(estimatedPriceInput) || 0
            : editingItem.estimatedPrice,
        priority:
          editingItem.listType === 'desejo' ? priorityInput : editingItem.priority,
        inspirationUrl:
          editingItem.listType === 'desejo'
            ? inspirationUrlInput.trim()
            : editingItem.inspirationUrl,
        prosAndCons:
          editingItem.listType === 'desejo'
            ? prosConsInput.trim()
            : editingItem.prosAndCons,
        updatedAt: new Date().toISOString(),
      };
      onUpdateItem(updatedItem);
    } else {
      const initialStages: Record<ListType, ItemStage> = {
        recorrente: 'estoque',
        objetivo: 'pesquisa',
        desejo: 'ideia',
      };

      onCreateItem({
        listId: activeList.id,
        workspaceId: workspace.id,
        name: itemName.trim(),
        groupId: selectedGroupId,
        categoryId: validCatId,
        listType: activeList.type,
        stage: initialStages[activeList.type],
        acceptedMemberEmails: workspace.acceptedMemberEmails,
        notes: itemNotes.trim(),
        currentStock:
          activeList.type === 'recorrente' ? Number(currentStockInput) || 0 : undefined,
        minStock:
          activeList.type === 'recorrente' ? Number(minStockInput) || 1 : undefined,
        unit: activeList.type === 'recorrente' ? unitInput : undefined,
        targetAmount:
          activeList.type === 'objetivo' ? Number(targetAmountInput) || 1000 : undefined,
        savedAmount: activeList.type === 'objetivo' ? 0 : undefined,
        quotes: activeList.type === 'objetivo' ? [] : undefined,
        deposits: activeList.type === 'objetivo' ? [] : undefined,
        estimatedPrice:
          activeList.type === 'desejo' ? Number(estimatedPriceInput) || 0 : undefined,
        priority: activeList.type === 'desejo' ? priorityInput : undefined,
        inspirationUrl:
          activeList.type === 'desejo' ? inspirationUrlInput.trim() : undefined,
        prosAndCons: activeList.type === 'desejo' ? prosConsInput.trim() : undefined,
      });
    }

    setEditingItem(null);
    setIsNewItemModalOpen(false);
  };

  const handleCartModalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cartModalState) return;
    if (!prodBrand.trim() || !prodStore.trim()) return;

    const unitPriceNum = Number(prodPrice) || 0;
    const qtyNum = Number(prodQty) || 1;
    const totalPaid = Number((unitPriceNum * qtyNum).toFixed(2));

    onConfirmCartCheckout(
      cartModalState.item,
      {
        brand: prodBrand.trim(),
        unitPrice: unitPriceNum,
        quantity: qtyNum,
        storeName: prodStore.trim(),
        receiptUrl: prodReceiptUrl || undefined,
      },
      cartModalState.advanceToConfirmed
    );

    if (
      cartModalState.advanceToConfirmed &&
      createExpenseOnCartConfirm &&
      onCreateExpenseFromPurchase &&
      totalPaid > 0
    ) {
      onCreateExpenseFromPurchase({
        description: `[Compra] ${cartModalState.item.name} - ${prodBrand.trim()} (${prodStore.trim()})`,
        amount: totalPaid,
        storeName: prodStore.trim(),
      });
    }

    setCreateExpenseOnCartConfirm(false);
    setCartModalState(null);
  };

  const handleReceiptFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploadingReceipt(true);
    try {
      const url = await uploadFileToFirebaseStorage(
        file,
        'receipts',
        currentUser.uid
      );
      setProdReceiptUrl(url);
    } finally {
      setIsUploadingReceipt(false);
    }
  };

  const handleDepositSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!depositModalItem) return;
    const amt = Number(depositAmount);
    if (!amt || amt <= 0) return;
    onAddGoalDeposit(depositModalItem, amt, depositNote.trim());
    setDepositModalItem(null);
    setDepositNote('');
  };

  const handleQuoteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quoteModalItem || !quoteStore.trim()) return;
    onAddGoalQuote(quoteModalItem, {
      storeName: quoteStore.trim(),
      url: quoteUrl.trim() || 'https://',
      price: Number(quotePrice) || 0,
      notes: quoteNotes.trim(),
    });
    setQuoteModalItem(null);
    setQuoteStore('');
    setQuoteUrl('');
    setQuotePrice('');
    setQuoteNotes('');
  };

  const handleCompleteGoalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!acquireGoalModalItem) return;
    const paidNum = Number(finalPaidInput) || 0;
    const storeStr = finalStoreInput.trim() || 'Loja Oficial';
    const brandStr = finalBrandInput.trim() || acquireGoalModalItem.name;

    onCompleteGoalAcquisition(
      acquireGoalModalItem,
      paidNum,
      storeStr,
      brandStr
    );

    if (createExpenseOnGoalComplete && onCreateExpenseFromPurchase && paidNum > 0) {
      onCreateExpenseFromPurchase({
        description: `[Meta Adquirida] ${acquireGoalModalItem.name} - ${brandStr} (${storeStr})`,
        amount: paidNum,
        storeName: storeStr,
      });
    }

    setCreateExpenseOnGoalComplete(false);
    setAcquireGoalModalItem(null);
  };

  const handleConvertWishSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!convertWishModalItem) return;
    const destId = targetGoalListId || goalListsInWorkspace[0]?.id;
    if (!destId) return;
    onConvertWishToGoal(convertWishModalItem, destId);
    setConvertWishModalItem(null);
  };

  const getTaxonomyLabel = (groupId: string, categoryId: string) => {
    const grp = taxonomyGroups.find((g) => g.id === groupId);
    const cat = grp?.categories.find((c) => c.id === categoryId);
    if (!grp) return 'Sem Classificação';
    return `${grp.name} · ${cat?.name || 'Geral'}`;
  };

  const getGroupNameOnly = (groupId: string) => {
    const grp = taxonomyGroups.find((g) => g.id === groupId);
    return grp?.name || 'Sem Categoria';
  };

  const listItems = activeList
    ? items.filter((i) => i.listId === activeList.id)
    : [];

  const isRecurringActiveList = activeList?.type === 'recorrente';
  const cartItems = isRecurringActiveList
    ? listItems.filter((i) => i.stage === 'carrinho')
    : [];
  const confirmedItems = isRecurringActiveList
    ? listItems.filter((i) => i.stage === 'conferido')
    : [];

  const cartSubtotal = cartItems.reduce((sum, item) => {
    if (item.cartDraft) {
      return sum + (Number(item.cartDraft.unitPrice) || 0) * (Number(item.cartDraft.quantity) || 1);
    }
    const lastPrice = item.productsHistory?.[0]?.unitPrice || 0;
    return sum + lastPrice;
  }, 0);

  const confirmedSubtotal = confirmedItems.reduce((sum, item) => {
    if (item.cartDraft) {
      return sum + (Number(item.cartDraft.unitPrice) || 0) * (Number(item.cartDraft.quantity) || 1);
    }
    const lastTotal = item.productsHistory?.[0]?.totalPrice || 0;
    return sum + lastTotal;
  }, 0);

  const recentListPurchases = listItems
    .flatMap((item) =>
      (item.productsHistory || []).map((purchase) => ({
        itemId: item.id,
        itemName: item.name,
        isCurrentlyConfirmed: item.stage === 'conferido',
        purchase,
      }))
    )
    .sort(
      (a, b) =>
        new Date(b.purchase.purchaseDate).getTime() -
        new Date(a.purchase.purchaseDate).getTime()
    )
    .slice(0, 8);

  const displayedStages =
    isRecurringActiveList && showOnlyCart
      ? stages.filter((s) => s.id === 'carrinho' || s.id === 'conferido')
      : stages;

  const activeFormListType = editingItem ? editingItem.listType : activeList?.type;

  // Render an individual Item Card inside a Kanban Column / Mobile Tab
  const renderItemCard = (item: AcquisitionItem) => {
    const nextStage = getNextStage(item.listType, item.stage);
    const prevStage = getPreviousStage(item.listType, item.stage);
    const priceStats = calculatePriceStats(item.productsHistory);
    const critical =
      item.listType === 'recorrente' &&
      item.stage === 'estoque' &&
      isStockCritical(item);
    const goalProgress =
      item.listType === 'objetivo'
        ? calculateGoalProgress(item.savedAmount, item.targetAmount)
        : 0;

    const currentStock = Number(item.currentStock ?? 0);
    const minStock = Math.max(1, Number(item.minStock ?? 1));
    const stockPct = Math.min(100, Math.round((currentStock / (minStock * 2)) * 100));

    const activeDraftOrLast = item.cartDraft
      ? {
          brand: item.cartDraft.brand,
          unitPrice: Number(item.cartDraft.unitPrice) || 0,
          quantity: Number(item.cartDraft.quantity) || 1,
          storeName: item.cartDraft.storeName,
        }
      : item.stage === 'conferido' && item.productsHistory?.[0]
      ? {
          brand: item.productsHistory[0].brand,
          unitPrice: Number(item.productsHistory[0].unitPrice) || 0,
          quantity: Number(item.productsHistory[0].quantity) || 1,
          storeName: item.productsHistory[0].storeName,
        }
      : null;

    const cardHighlightClass =
      item.stage === 'carrinho'
        ? 'border-indigo-500/60 bg-slate-900 shadow-indigo-950/30'
        : item.stage === 'conferido' || item.stage === 'adquirido'
        ? 'border-emerald-500/50 bg-slate-900 shadow-emerald-950/20'
        : critical
        ? 'border-rose-500/50 bg-slate-900'
        : 'border-slate-700/80 bg-slate-900 hover:border-slate-600';

    return (
      <div
        key={item.id}
        className={`${cardHighlightClass} border rounded-xl p-4 space-y-3.5 shadow-sm transition-colors`}
      >
        {/* Top Taxonomy Metadata Line + Edit / Delete Item Actions */}
        <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
          <span className="truncate px-2 py-0.5 rounded-md bg-slate-800/90 border border-slate-700/70 text-slate-300">
            {getTaxonomyLabel(item.groupId, item.categoryId)}
          </span>

          <div className="flex items-center gap-1 shrink-0">
            {item.listType === 'desejo' && item.priority && (
              <span
                className={`font-semibold mr-1 ${
                  item.priority === 'Alta'
                    ? 'text-rose-400'
                    : item.priority === 'Média'
                    ? 'text-amber-400'
                    : 'text-slate-400'
                }`}
              >
                {item.priority}
              </span>
            )}
            <button
              type="button"
              onClick={() => openEditItemModal(item)}
              aria-label={`Editar item ${item.name}`}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <Edit3 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setDeletingItem(item)}
              aria-label={`Apagar item ${item.name}`}
              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-950/50 transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Item Generic Name */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <h4 className="text-sm font-bold text-slate-100 font-display leading-snug">
              {item.name}
            </h4>
            {item.notes && (
              <p className="text-xs text-slate-400 mt-1 line-clamp-2">
                {item.notes}
              </p>
            )}
          </div>
          {item.stage === 'carrinho' && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 shrink-0">
              No Carrinho
            </span>
          )}
          {item.stage === 'conferido' && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 shrink-0">
              Comprado
            </span>
          )}
        </div>

        {/* =============================================================== */}
        {/* 1. LISTA RECORRENTE SPECIFIC DETAILS                            */}
        {/* =============================================================== */}
        {item.listType === 'recorrente' && (
          <div className="space-y-2.5 pt-1">
            <div className="p-2.5 rounded-xl bg-slate-800/70 border border-slate-700/60 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <div>
                  <span className="text-slate-400 block text-[11px]">
                    Estoque Atual / Mínimo
                  </span>
                  <span className="font-mono font-semibold tabular-nums text-slate-100">
                    {currentStock} {item.unit || 'un'}{' '}
                    <span className="text-slate-400 font-normal">
                      / mín. {item.minStock ?? 1} {item.unit || 'un'}
                    </span>
                  </span>
                </div>

                {critical ? (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-400">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    <span>Abaixo da Mínima</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    <span>Estoque Normal</span>
                  </span>
                )}
              </div>

              {/* Stock progress bar */}
              <div className="w-full h-1.5 rounded-full bg-slate-900 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    critical
                      ? 'bg-rose-500'
                      : currentStock <= minStock * 1.25
                      ? 'bg-amber-400'
                      : 'bg-emerald-500'
                  }`}
                  style={{ width: `${Math.max(6, stockPct)}%` }}
                />
              </div>

              {/* Quick Stock Consumption Controls in Status 1 (Estoque) */}
              {item.stage === 'estoque' && (
                <div className="pt-2 border-t border-slate-700/60 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-400">
                    Giro rápido:
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onAdjustItemStock(item, -1, true)}
                      aria-label={`Consumir 1 unidade de ${item.name}`}
                      className="px-2 py-1 text-[11px] font-medium rounded-lg bg-slate-900 border border-slate-700 text-slate-300 hover:border-rose-500/60 hover:text-rose-400 transition-colors flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Minus className="w-3 h-3" />
                      <span>Consumir 1</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onAdjustItemStock(item, 1, false)}
                      aria-label={`Somar 1 unidade em ${item.name}`}
                      className="px-2 py-1 text-[11px] font-medium rounded-lg bg-slate-900 border border-slate-700 text-slate-300 hover:border-indigo-500/60 hover:text-indigo-300 transition-colors flex items-center gap-0.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                      <span>1</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Active Cart or Confirmed Purchase Instance Details */}
            {(item.stage === 'carrinho' || item.stage === 'conferido') &&
              activeDraftOrLast && (
                <div
                  className={`p-3 rounded-xl border text-xs space-y-1.5 ${
                    item.stage === 'conferido'
                      ? 'bg-emerald-950/40 border-emerald-500/35'
                      : 'bg-indigo-950/45 border-indigo-500/35'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 font-semibold text-slate-100">
                    <span className="truncate">
                      {activeDraftOrLast.brand || item.name}
                    </span>
                    <span
                      className={`font-mono tabular-nums font-bold shrink-0 ${
                        item.stage === 'conferido' ? 'text-emerald-300' : 'text-indigo-300'
                      }`}
                    >
                      {formatCurrencyBRL(
                        activeDraftOrLast.unitPrice * activeDraftOrLast.quantity
                      )}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-slate-300 font-mono tabular-nums">
                    <span className="truncate">
                      {activeDraftOrLast.quantity} {item.unit || 'un'} ×{' '}
                      {formatCurrencyBRL(activeDraftOrLast.unitPrice)} ·{' '}
                      {activeDraftOrLast.storeName}
                    </span>
                    {item.stage === 'carrinho' && (
                      <button
                        type="button"
                        onClick={() => handleOpenCartProductModal(item, false)}
                        className="underline font-sans font-semibold text-indigo-300 hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Editar Produto
                      </button>
                    )}
                  </div>
                  {item.stage === 'conferido' && onCreateExpenseFromPurchase && (
                    <div className="pt-1.5 border-t border-emerald-500/25 flex justify-end">
                      <button
                        type="button"
                        onClick={() =>
                          onCreateExpenseFromPurchase({
                            description: `[Compra] ${item.name} - ${activeDraftOrLast.brand} (${activeDraftOrLast.storeName})`.trim(),
                            amount: Number(
                              (
                                activeDraftOrLast.unitPrice *
                                activeDraftOrLast.quantity
                              ).toFixed(2)
                            ),
                            storeName: activeDraftOrLast.storeName,
                          })
                        }
                        className="text-[11px] font-semibold text-emerald-300 hover:text-emerald-200 hover:underline flex items-center gap-1 cursor-pointer"
                      >
                        <span>+ Lançar como Despesa no Financeiro</span>
                      </button>
                    </div>
                  )}
                </div>
              )}

            {/* Historical Price Summary & Subcollection Trigger */}
            <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400 pt-1">
              {priceStats.lastPrice !== null ? (
                <span className="font-mono tabular-nums truncate">
                  Último: {formatCurrencyBRL(priceStats.lastPrice)} ({priceStats.lastBrand})
                </span>
              ) : (
                <span className="truncate">Sem histórico de compras</span>
              )}
              <button
                type="button"
                onClick={() => setHistoryModalItem(item)}
                className="text-indigo-400 hover:text-indigo-300 hover:underline font-medium flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <History className="w-3 h-3 shrink-0" />
                <span>Histórico ({item.productsHistory?.length || 0})</span>
              </button>
            </div>
          </div>
        )}

        {/* =============================================================== */}
        {/* 2. LISTA DE OBJETIVO SPECIFIC DETAILS                           */}
        {/* =============================================================== */}
        {item.listType === 'objetivo' && (
          <div className="space-y-3 pt-1">
            {/* Progress Bar & Target */}
            <div className="space-y-1.5 p-2.5 rounded-xl bg-slate-800/70 border border-slate-700/60">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">
                  Poupado:{' '}
                  <strong className="font-mono tabular-nums text-slate-100">
                    {formatCurrencyBRL(item.savedAmount)}
                  </strong>
                </span>
                <span className="font-mono tabular-nums text-slate-300">
                  Meta: {formatCurrencyBRL(item.targetAmount)} ({goalProgress}%)
                </span>
              </div>
              <div className="w-full h-2 rounded-full bg-slate-900 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    goalProgress >= 100 ? 'bg-emerald-500' : 'bg-indigo-500'
                  }`}
                  style={{ width: `${goalProgress}%` }}
                />
              </div>
            </div>

            {/* Quotes List (Pesquisa/Cotação) with Delete Action */}
            {item.quotes && item.quotes.length > 0 && (
              <div className="space-y-1 pt-1">
                <span className="text-[11px] font-medium text-slate-400 block">
                  Cotações & Links Salvos:
                </span>
                {item.quotes.map((q) => (
                  <div
                    key={q.id}
                    className="flex items-center justify-between gap-2 text-xs py-1.5 px-2.5 rounded-lg bg-slate-800/70 border border-slate-700/60"
                  >
                    <a
                      href={q.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-400 hover:underline flex items-center gap-1 truncate max-w-[140px]"
                    >
                      <ExternalLink className="w-3 h-3 shrink-0" />
                      <span className="truncate">{q.storeName}</span>
                    </a>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="font-mono tabular-nums font-semibold text-slate-200">
                        {formatCurrencyBRL(q.price)}
                      </span>
                      <button
                        type="button"
                        onClick={() => onDeleteGoalQuote(item, q.id)}
                        aria-label={`Remover cotação ${q.storeName}`}
                        className="text-slate-400 hover:text-rose-400 p-0.5 cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Status 3 (Pronto para Executar) Released Funds Banner */}
            {item.stage === 'pronto' && (
              <div className="p-2.5 rounded-xl bg-indigo-950/50 border border-indigo-500/40 text-xs flex items-center justify-between gap-2">
                <span className="font-semibold text-indigo-200">
                  Meta atingida! Valor liberado para execução.
                </span>
                <span className="font-mono font-bold text-indigo-300 shrink-0">
                  100%
                </span>
              </div>
            )}

            {/* Status 4 (Adquirido) Detailed Final Financial Report */}
            {item.stage === 'adquirido' && (() => {
              const report = calculateGoalFinalReport(item);
              return (
                <div className="p-3 rounded-xl bg-emerald-950/45 border border-emerald-500/35 text-xs space-y-2">
                  <div className="flex items-center justify-between font-semibold text-emerald-200 border-b border-emerald-500/25 pb-1.5">
                    <span>Relatório de Valor Final</span>
                    <span>{item.acquiredStore || 'Compra Concluída'}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 font-mono tabular-nums text-[11px]">
                    <div>
                      <span className="text-emerald-300/80 block font-sans">
                        Guardado / Orçado:
                      </span>
                      <strong className="text-slate-100">
                        {formatCurrencyBRL(report.savedAmount)}
                      </strong>
                    </div>
                    <div>
                      <span className="text-emerald-300/80 block font-sans">
                        Efetivamente Pago:
                      </span>
                      <strong className="text-slate-100">
                        {formatCurrencyBRL(report.paidAmount)}
                      </strong>
                    </div>
                  </div>
                  <div className="pt-1 border-t border-emerald-500/25 flex items-center justify-between text-[11px]">
                    <span className="text-emerald-300 font-medium">
                      Diferença vs. Orçado:
                    </span>
                    <span
                      className={`font-mono font-bold tabular-nums ${
                        report.differenceFromBudget >= 0
                          ? 'text-emerald-300'
                          : 'text-rose-400'
                      }`}
                    >
                      {report.differenceFromBudget >= 0
                        ? `Economia de ${formatCurrencyBRL(report.differenceFromBudget)}`
                        : `Excedente de ${formatCurrencyBRL(Math.abs(report.differenceFromBudget))}`}
                    </span>
                  </div>
                  {onCreateExpenseFromPurchase && report.paidAmount > 0 && (
                    <div className="pt-1.5 border-t border-emerald-500/25 flex justify-end">
                      <button
                        type="button"
                        onClick={() =>
                          onCreateExpenseFromPurchase({
                            description: `[Meta Adquirida] ${item.name} (${item.acquiredStore || 'Compra'})`,
                            amount: report.paidAmount,
                            storeName: item.acquiredStore,
                          })
                        }
                        className="text-[11px] font-semibold text-indigo-300 hover:text-indigo-200 hover:underline flex items-center gap-1 cursor-pointer"
                      >
                        <span>+ Lançar como Despesa no Financeiro</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Goal Specific Action Buttons */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setQuoteModalItem(item)}
                className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-700 bg-slate-800/80 text-slate-200 hover:bg-slate-800 transition-colors flex items-center gap-1 cursor-pointer"
              >
                <Link2 className="w-3.5 h-3.5 text-indigo-400" />
                <span>+ Cotação/Link</span>
              </button>

              {(item.stage === 'poupando' || item.stage === 'pesquisa') && (
                <button
                  type="button"
                  onClick={() => {
                    setDepositModalItem(item);
                    setDepositAmount('300');
                  }}
                  className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors flex items-center gap-1 cursor-pointer"
                >
                  <PiggyBank className="w-3.5 h-3.5" />
                  <span>Depositar</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* =============================================================== */}
        {/* 3. LISTA DE DESEJO SPECIFIC DETAILS                             */}
        {/* =============================================================== */}
        {item.listType === 'desejo' && (
          <div className="space-y-2.5 pt-1">
            <div className="flex items-center justify-between text-xs p-2.5 rounded-xl bg-slate-800/70 border border-slate-700/60">
              <span className="text-slate-400">Valor Estimado:</span>
              <span className="font-mono tabular-nums font-semibold text-slate-100">
                {formatCurrencyBRL(item.estimatedPrice)}
              </span>
            </div>

            {item.prosAndCons && (
              <p className="text-xs text-slate-300 bg-slate-800/60 border border-slate-700/60 p-2.5 rounded-xl">
                {item.prosAndCons}
              </p>
            )}

            {item.convertedToGoalItemId ? (
              <div className="p-2.5 rounded-xl bg-indigo-950/50 border border-indigo-500/35 text-indigo-300 text-xs font-medium">
                Convertido em Objetivo Financeiro com sucesso.
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setConvertWishModalItem(item);
                  setTargetGoalListId(goalListsInWorkspace[0]?.id || '');
                }}
                className="w-full py-2 px-3 text-xs font-semibold rounded-xl bg-indigo-950/60 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-900/60 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Converter Desejo em Objetivo</span>
              </button>
            )}
          </div>
        )}

        {/* =============================================================== */}
        {/* STATE MACHINE NAVIGATION CONTROLS (↩ REVERT & ADVANCE ➔)        */}
        {/* =============================================================== */}
        <div className="pt-3 border-t border-slate-800 flex items-center justify-between gap-2">
          {prevStage ? (
            <button
              type="button"
              onClick={() => handleRevertClick(item)}
              aria-label={`Reverter ${item.name} para etapa anterior`}
              className="min-h-[38px] px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <CornerUpLeft className="w-3.5 h-3.5 shrink-0" />
              <span>↩ Reverter</span>
            </button>
          ) : (
            <span className="text-[11px] text-slate-500 whitespace-nowrap">
              Etapa Inicial
            </span>
          )}

          {nextStage ? (
            <button
              type="button"
              onClick={() => handleAdvanceClick(item)}
              aria-label={`Avançar ${item.name} para próxima etapa`}
              className="min-h-[38px] px-3.5 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors flex items-center gap-1.5 ml-auto whitespace-nowrap shrink-0 cursor-pointer"
            >
              <span>
                {item.listType === 'recorrente' && nextStage === 'comprar'
                  ? 'Enviar p/ Comprar'
                  : item.listType === 'recorrente' && nextStage === 'carrinho'
                  ? 'Ao Carrinho'
                  : item.listType === 'recorrente' && nextStage === 'conferido'
                  ? 'Conferir'
                  : item.listType === 'objetivo' && nextStage === 'adquirido'
                  ? 'Concluir Meta'
                  : 'Avançar'}
              </span>
              <ArrowRight className="w-3.5 h-3.5 shrink-0" />
            </button>
          ) : item.listType === 'recorrente' && item.stage === 'conferido' ? (
            <button
              type="button"
              onClick={() => onReturnConfirmedToStock(item)}
              aria-label={`Novo ciclo de estoque para ${item.name}`}
              className="min-h-[38px] px-3 py-1.5 text-xs font-semibold text-emerald-300 bg-emerald-950/60 border border-emerald-500/40 hover:bg-emerald-900/60 rounded-lg transition-colors flex items-center gap-1.5 ml-auto whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5 shrink-0" />
              <span>Repor Despensa</span>
            </button>
          ) : (
            <span className="text-xs font-semibold text-emerald-400 ml-auto whitespace-nowrap">
              Ciclo Concluído
            </span>
          )}
        </div>
      </div>
    );
  };

  const renderColumnCards = (columnItems: AcquisitionItem[]) => {
    if (!groupByCategory) {
      return columnItems.map((item) => renderItemCard(item));
    }

    const grouped = new Map<string, AcquisitionItem[]>();
    columnItems.forEach((item) => {
      const grpName = getGroupNameOnly(item.groupId);
      const bucket = grouped.get(grpName) || [];
      bucket.push(item);
      grouped.set(grpName, bucket);
    });

    return Array.from(grouped.entries()).map(([groupName, grpItems]) => (
      <div key={groupName} className="space-y-2">
        <div className="flex items-center justify-between px-2 py-1 rounded-lg bg-slate-950/60 border border-slate-800 text-[11px] font-bold uppercase tracking-wider text-slate-400">
          <span className="truncate">{groupName}</span>
          <span className="font-mono text-indigo-400">{grpItems.length}</span>
        </div>
        <div className="space-y-2.5">{grpItems.map((it) => renderItemCard(it))}</div>
      </div>
    ));
  };

  return (
    <div className="space-y-5">
      {/* Workspace Contextual Header */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 sm:p-6 space-y-5 shadow-lg">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              {!isPersonalVirtualWs ? (
                <>
                  <button
                    type="button"
                    onClick={onBackToHub}
                    className="text-indigo-400 hover:underline font-medium flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <ArrowLeft className="w-3.5 h-3.5 shrink-0" />
                    <span>Meus Espaços</span>
                  </button>
                  <span aria-hidden="true">/</span>
                </>
              ) : null}
              <span className="whitespace-nowrap">{workspace.type}</span>
              {!isPersonalVirtualWs && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums whitespace-nowrap text-slate-300">
                    Orçamento: {formatCurrencyBRL(workspace.monthlyBudget)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    onClick={() => {
                      setEditWsName(workspace.name);
                      setEditWsDesc(workspace.description);
                      setEditWsType(workspace.type);
                      setEditWsBudget(String(workspace.monthlyBudget ?? 0));
                      setIsEditWorkspaceOpen(true);
                    }}
                    className="text-slate-400 hover:text-indigo-400 inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Edit3 className="w-3 h-3" />
                    <span>Editar Espaço</span>
                  </button>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    onClick={() => setIsDeleteWorkspaceOpen(true)}
                    className="text-slate-400 hover:text-rose-400 inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>Apagar Espaço</span>
                  </button>
                </>
              )}
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-100 font-display">
              {workspace.name}
            </h1>
            <p className="text-xs text-slate-400 max-w-2xl">
              {workspace.description}
            </p>
          </div>

          {/* Workspace Action Bar */}
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            {!isPersonalVirtualWs && (
              <button
                type="button"
                onClick={() => {
                  setInviteSuccessMsg('');
                  setIsMembersModalOpen(true);
                }}
                className="min-h-[42px] px-3.5 py-2 text-xs font-medium rounded-xl border border-slate-700 bg-slate-900/80 text-slate-200 hover:bg-slate-800 transition-colors flex items-center gap-2 whitespace-nowrap cursor-pointer"
              >
                <Users className="w-4 h-4 text-indigo-400" />
                <span>Membros ({workspace.members.length})</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setIsNewListModalOpen(true)}
              className="min-h-[42px] px-3.5 py-2 text-xs font-medium rounded-xl border border-slate-700 bg-slate-900/80 text-slate-200 hover:bg-slate-800 transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Plus className="w-4 h-4 text-amber-400" />
              <span>Nova Lista</span>
            </button>

            <button
              type="button"
              onClick={openNewItemModal}
              disabled={!activeList}
              className="min-h-[42px] px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-xl transition-colors flex items-center gap-1.5 whitespace-nowrap shadow-md shadow-indigo-500/20 cursor-pointer disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              <span>Adicionar Item</span>
            </button>
          </div>
        </div>

        {/* List Selector Tabs + Active List Edit & Delete Controls */}
        <div className="pt-4 border-t border-slate-700/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div
            className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0"
            role="tablist"
            aria-label="Listas do espaço"
          >
            {workspaceLists.map((list) => {
              const isSelected = activeList?.id === list.id;
              const count = items.filter((i) => i.listId === list.id).length;
              return (
                <button
                  key={list.id}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  onClick={() => handleSelectList(list)}
                  className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-xl transition-colors flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer ${
                    isSelected
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'bg-slate-900 border border-slate-700/80 text-slate-400 hover:text-slate-100 hover:border-slate-600'
                  }`}
                >
                  <span>{list.name}</span>
                  <span className="font-mono text-[11px] opacity-85">
                    ({count})
                  </span>
                </button>
              );
            })}
          </div>

          {activeList && (
            <div className="flex flex-wrap items-center gap-2.5 text-xs text-slate-400 shrink-0">
              <button
                type="button"
                onClick={() => setGroupByCategory((prev) => !prev)}
                className={`px-2.5 py-1.5 rounded-lg border text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                  groupByCategory
                    ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-300'
                    : 'bg-slate-900 border-slate-700 text-slate-300 hover:text-white'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Agrupar por categoria</span>
              </button>
              <span aria-hidden="true">·</span>
              <span>
                Tipo:{' '}
                <strong className="text-slate-200 capitalize">
                  {activeList.type}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => openEditListModal(activeList)}
                aria-label={`Editar lista ${activeList.name}`}
                className="text-slate-300 hover:text-indigo-400 font-medium inline-flex items-center gap-1 cursor-pointer"
              >
                <Edit3 className="w-3.5 h-3.5" />
                <span>Editar Lista</span>
              </button>
              <button
                type="button"
                onClick={() => setDeletingList(activeList)}
                aria-label={`Apagar lista ${activeList.name}`}
                className="text-rose-400 hover:underline font-medium inline-flex items-center gap-1 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Apagar Lista</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Live Cart & Confirmed Summary Bar for Recurring Lists */}
      {activeList && isRecurringActiveList && (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-indigo-950/60 border border-indigo-500/40">
              <ShoppingCart className="w-4 h-4 text-indigo-400 shrink-0" />
              <div className="text-xs">
                <span className="text-indigo-300 font-semibold block">
                  No Carrinho ({cartItems.length})
                </span>
                <span className="font-mono font-bold text-white">
                  {formatCurrencyBRL(cartSubtotal)}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-emerald-950/50 border border-emerald-500/35">
              <PackageCheck className="w-4 h-4 text-emerald-400 shrink-0" />
              <div className="text-xs">
                <span className="text-emerald-300 font-semibold block">
                  Comprados / Conferidos ({confirmedItems.length})
                </span>
                <span className="font-mono font-bold text-white">
                  {formatCurrencyBRL(confirmedSubtotal)}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowOnlyCart((prev) => !prev)}
              className={`px-3 py-2 rounded-xl border text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                showOnlyCart
                  ? 'bg-indigo-600 text-white border-indigo-500'
                  : 'bg-slate-900 border-slate-700 text-slate-300 hover:text-white'
              }`}
            >
              <Filter className="w-3.5 h-3.5" />
              <span>{showOnlyCart ? 'Mostrar Todas Etapas' : 'Focar Carrinho & Conferidos'}</span>
            </button>

            <button
              type="button"
              onClick={() => setShowBoughtPanel((prev) => !prev)}
              className="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs font-semibold text-slate-300 hover:text-white flex items-center gap-1.5 cursor-pointer"
            >
              <History className="w-3.5 h-3.5 text-emerald-400" />
              <span>{showBoughtPanel ? 'Ocultar Resumo Comprados' : 'Ver Resumo Comprados'}</span>
            </button>
          </div>
        </div>
      )}

      {!activeList ? (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-10 text-center space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 flex items-center justify-center mx-auto">
            <ShoppingCart className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h3 className="text-base font-bold text-white">
              Nenhuma lista criada neste espaço
            </h3>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              Crie uma lista recorrente (despensa/compras do mês), de objetivo financeiro ou de desejos para começar a gerenciar suas aquisições.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setIsNewListModalOpen(true)}
            className="min-h-[42px] px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-xl transition-colors inline-flex items-center gap-2 shadow-xs cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>+ Criar Primeira Lista</span>
          </button>
        </div>
      ) : (
        <>
          {/* =================================================================== */}
          {/* MOBILE SWIPEABLE STAGE TABS (< lg)                                  */}
          {/* =================================================================== */}
          <div className="lg:hidden space-y-4">
            <div
              className="flex items-center gap-1.5 overflow-x-auto p-1.5 bg-slate-800/90 border border-slate-700/80 rounded-2xl"
              role="tablist"
              aria-label="Colunas da lista no celular"
            >
              {displayedStages.map((st) => {
                const count = listItems.filter((i) => i.stage === st.id).length;
                const isTabActive = activeMobileStage === st.id;
                return (
                  <button
                    key={st.id}
                    type="button"
                    role="tab"
                    aria-selected={isTabActive}
                    onClick={() => setActiveMobileStage(st.id as ItemStage)}
                    className={`min-h-[44px] px-3.5 py-2 text-xs font-semibold rounded-xl transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer ${
                      isTabActive
                        ? 'bg-indigo-600 text-white shadow-xs'
                        : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
                    }`}
                  >
                    <span>{st.label}</span>
                    <span className="font-mono text-[11px] opacity-85">
                      ({count})
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Active Mobile Stage Cards */}
            <div className="space-y-3">
              {listItems.filter((i) => i.stage === activeMobileStage).length === 0 ? (
                <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-8 text-center space-y-2">
                  <p className="text-sm font-semibold text-slate-300">
                    Nenhum item nesta etapa
                  </p>
                  <p className="text-xs text-slate-400">
                    Adicione um novo item ou avance cards das etapas anteriores.
                  </p>
                </div>
              ) : (
                renderColumnCards(
                  listItems.filter((i) => i.stage === activeMobileStage)
                )
              )}
            </div>
          </div>

          {/* =================================================================== */}
          {/* DESKTOP KANBAN BOARD WITH LATERAL SCROLL (>= lg)                    */}
          {/* =================================================================== */}
          <div className="hidden lg:flex items-start gap-4 overflow-x-auto pb-4">
            {displayedStages.map((stageObj, idx) => {
              const columnItems = listItems.filter((i) => i.stage === stageObj.id);
              const isCartCol = stageObj.id === 'carrinho';
              const isConfirmedCol = stageObj.id === 'conferido' || stageObj.id === 'adquirido';

              return (
                <div
                  key={stageObj.id}
                  className={`flex-1 min-w-[285px] rounded-2xl p-4 flex flex-col gap-3.5 min-h-[520px] border ${
                    isCartCol
                      ? 'bg-indigo-950/25 border-indigo-500/35'
                      : isConfirmedCol
                      ? 'bg-emerald-950/20 border-emerald-500/30'
                      : 'bg-slate-800/75 border-slate-700/80'
                  }`}
                >
                  {/* Column Header */}
                  <div className="flex items-start justify-between gap-2 pb-2.5 border-b border-slate-700/70">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`text-xs font-mono font-bold ${
                            isConfirmedCol ? 'text-emerald-400' : 'text-indigo-400'
                          }`}
                        >
                          0{idx + 1}.
                        </span>
                        <h3 className="text-sm font-bold text-slate-100 font-display">
                          {stageObj.label}
                        </h3>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        {stageObj.subtitle}
                      </p>
                    </div>
                    <span className="text-xs font-mono font-semibold tabular-nums text-slate-300 px-2 py-0.5 rounded-md bg-slate-900 border border-slate-700">
                      {columnItems.length}
                    </span>
                  </div>

                  {/* Column Cards */}
                  <div className="space-y-3 flex-1">
                    {columnItems.length === 0 ? (
                      <div className="h-40 rounded-xl border border-dashed border-slate-700 flex flex-col items-center justify-center p-4 text-center">
                        <p className="text-xs text-slate-500">
                          Sem itens em &ldquo;{stageObj.label}&rdquo;
                        </p>
                      </div>
                    ) : (
                      renderColumnCards(columnItems)
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* =================================================================== */}
          {/* PANEL: COMPRADOS / CONFERIDOS & HISTÓRICO RECENTE                   */}
          {/* =================================================================== */}
          {isRecurringActiveList &&
            showBoughtPanel &&
            (confirmedItems.length > 0 || recentListPurchases.length > 0) && (
              <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 space-y-3">
                <div className="flex items-center justify-between gap-2 border-b border-slate-700/70 pb-3">
                  <div className="flex items-center gap-2">
                    <PackageCheck className="w-4 h-4 text-emerald-400" />
                    <h3 className="text-sm font-bold text-slate-100">
                      Comprados, Conferidos & Histórico Recente ({activeList.name})
                    </h3>
                  </div>
                  <span className="text-xs font-mono text-emerald-300 font-semibold">
                    Conferidos nesta lista: {formatCurrencyBRL(confirmedSubtotal)}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                  {recentListPurchases.map(({ itemName, isCurrentlyConfirmed, purchase }) => (
                    <div
                      key={purchase.id}
                      className="p-3 rounded-xl bg-slate-900/90 border border-slate-700/80 space-y-1 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-slate-100 truncate">
                          {itemName}
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 ${
                            isCurrentlyConfirmed
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : 'bg-slate-800 text-slate-400'
                          }`}
                        >
                          {isCurrentlyConfirmed ? 'Conferido' : 'Histórico'}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 truncate">
                        {purchase.brand} · {purchase.storeName}
                      </p>
                      <div className="flex items-center justify-between pt-1 font-mono tabular-nums">
                        <span className="text-[11px] text-slate-400">
                          {purchase.quantity} × {formatCurrencyBRL(purchase.unitPrice)}
                        </span>
                        <span className="font-bold text-emerald-300">
                          {formatCurrencyBRL(purchase.totalPrice)}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500 font-mono">
                        {new Date(purchase.purchaseDate).toLocaleDateString('pt-BR')}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
        </>
      )}

      {/* =================================================================== */}
      {/* MODAL: EDIT WORKSPACE                                               */}
      {/* =================================================================== */}
      <ResponsiveSheetModal
        isOpen={isEditWorkspaceOpen}
        onClose={() => setIsEditWorkspaceOpen(false)}
        title="Editar Espaço de Trabalho"
        subtitle="Atualize o nome, modalidade, descrição ou orçamento mensal."
      >
        <form onSubmit={handleEditWorkspaceSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="ws-board-edit-name"
              className="block text-xs font-medium text-slate-300 mb-1"
            >
              Nome do Espaço
            </label>
            <input
              id="ws-board-edit-name"
              type="text"
              required
              value={editWsName}
              onChange={(e) => setEditWsName(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="block text-xs font-medium text-slate-300 mb-1">
                Modalidade
              </span>
              <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-800 rounded-lg border border-slate-700">
                {(['Compartilhado', 'Individual'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setEditWsType(t)}
                    className={`py-2 px-2 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                      editWsType === t
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label
                htmlFor="ws-board-edit-budget"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Orçamento Mensal (R$)
              </label>
              <input
                id="ws-board-edit-budget"
                type="number"
                step="50"
                value={editWsBudget}
                onChange={(e) => setEditWsBudget(e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="ws-board-edit-desc"
              className="block text-xs font-medium text-slate-300 mb-1"
            >
              Descrição
            </label>
            <textarea
              id="ws-board-edit-desc"
              rows={2}
              value={editWsDesc}
              onChange={(e) => setEditWsDesc(e.target.value)}
              className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsEditWorkspaceOpen(false)}
              className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
            >
              Salvar Alterações
            </button>
          </div>
        </form>
      </ResponsiveSheetModal>

      {/* =================================================================== */}
      {/* MODAL: DELETE WORKSPACE CONFIRMATION                                */}
      {/* =================================================================== */}
      <ResponsiveSheetModal
        isOpen={isDeleteWorkspaceOpen}
        onClose={() => setIsDeleteWorkspaceOpen(false)}
        title="Apagar Espaço de Trabalho"
        subtitle={`Tem certeza que deseja excluir o espaço "${workspace.name}"?`}
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-400">
            Todas as listas e itens vinculados a este espaço serão removidos.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsDeleteWorkspaceOpen(false)}
              className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => {
                setIsDeleteWorkspaceOpen(false);
                onDeleteWorkspace(workspace.id);
              }}
              className="px-5 py-2.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg cursor-pointer"
            >
              Confirmar Exclusão
            </button>
          </div>
        </div>
      </ResponsiveSheetModal>

      {/* =================================================================== */}
      {/* MODAL 1: WORKSPACE MEMBERS & MULTI-EMAIL INVITE                     */}
      {/* =================================================================== */}
      <ResponsiveSheetModal
        isOpen={isMembersModalOpen}
        onClose={() => setIsMembersModalOpen(false)}
        title="Pessoas e Convites do Espaço"
        subtitle="Convide pessoas por e-mail, acompanhe quem aceitou ou recusou e gerencie o acesso."
        maxWidthClass="md:max-w-xl"
      >
        <form onSubmit={handleInviteSubmit} className="space-y-3">
          <label
            htmlFor="multi-email-invite"
            className="block text-xs font-medium text-slate-300"
          >
            Convidar Pessoas por E-mail (separados por vírgula ou quebra de linha)
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              id="multi-email-invite"
              type="text"
              value={inviteEmailsInput}
              onChange={(e) => setInviteEmailsInput(e.target.value)}
              placeholder="amigo1@email.com, familiar2@email.com"
              className="flex-1 px-3.5 py-2.5 text-xs font-mono rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              className="px-4 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Enviar Convites
            </button>
          </div>
          {inviteSuccessMsg && (
            <p className="text-xs text-emerald-400 font-medium">
              {inviteSuccessMsg}
            </p>
          )}
        </form>

        <div className="pt-3 border-t border-slate-800 space-y-2.5">
          <h3 className="text-xs font-semibold text-slate-400">
            Participantes do Espaço
          </h3>

          <div className="divide-y divide-slate-800 border-t border-b border-slate-800">
            {workspace.members.map((member) => (
              <div
                key={member.email}
                className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
              >
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-100">
                      {member.name || member.email.split('@')[0]}
                    </span>
                    <span className="text-slate-500">·</span>
                    <span className="text-slate-400 font-mono">
                      {member.email}
                    </span>
                  </div>
                  {member.status === 'Recusado' && member.rejectionReason && (
                    <p className="text-[11px] text-rose-400">
                      Motivo da recusa: {member.rejectionReason}
                      {member.rejectionNote ? ` — "${member.rejectionNote}"` : ''}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <select
                    aria-label={`Status do membro ${member.email}`}
                    value={member.status}
                    onChange={(e) =>
                      onUpdateMemberStatus(
                        workspace.id,
                        member.email,
                        e.target.value as 'Pendente' | 'Aceito' | 'Recusado'
                      )
                    }
                    className={`px-2.5 py-1 text-xs font-semibold rounded-md border ${
                      member.status === 'Aceito'
                        ? 'bg-emerald-950/50 text-emerald-300 border-emerald-800'
                        : member.status === 'Pendente'
                        ? 'bg-amber-950/50 text-amber-300 border-amber-800'
                        : 'bg-rose-950/50 text-rose-300 border-rose-800'
                    }`}
                  >
                    <option value="Aceito">Aceito</option>
                    <option value="Pendente">Pendente</option>
                    <option value="Recusado">Recusado</option>
                  </select>

                  {workspace.members.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onRemoveMember(workspace.id, member.email)}
                      aria-label={`Remover membro ${member.email}`}
                      className="p-1.5 rounded text-slate-400 hover:text-rose-400 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </ResponsiveSheetModal>

      {/* =================================================================== */}
      {/* MODAL 2: CREATE NEW LIST (SIMPLE BUTTON TYPE SELECTOR)              */}
      {/* =================================================================== */}
      <ResponsiveSheetModal
        isOpen={isNewListModalOpen}
        onClose={() => setIsNewListModalOpen(false)}
        title="Nova Lista"
        subtitle="Selecione o tipo de lista e informe o nome."
      >
        <form onSubmit={handleCreateListSubmit} className="space-y-4">
          <div>
            <span className="block text-xs font-medium text-slate-300 mb-1.5">
              Tipo da Lista
            </span>
            <div className="grid grid-cols-3 gap-2">
              {LIST_TYPE_BUTTONS.map((btn) => {
                const isSelected = newListType === btn.id;
                return (
                  <button
                    key={btn.id}
                    type="button"
                    onClick={() => setNewListType(btn.id)}
                    className={`min-h-[42px] py-2 px-3 text-xs font-semibold rounded-xl border transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                        : 'bg-slate-800/70 text-slate-300 border-slate-700 hover:border-indigo-400'
                    }`}
                  >
                    {btn.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label
              htmlFor="new-list-name"
              className="block text-xs font-medium text-slate-300 mb-1"
            >
              Nome da Lista
            </label>
            <input
              id="new-list-name"
              type="text"
              required
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
              placeholder="Ex: Feira Semanal & Orgânicos"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label
              htmlFor="new-list-desc"
              className="block text-xs font-medium text-slate-300 mb-1"
            >
              Descrição (opcional)
            </label>
            <input
              id="new-list-desc"
              type="text"
              value={newListDesc}
              onChange={(e) => setNewListDesc(e.target.value)}
              placeholder="Objetivo desta lista..."
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsNewListModalOpen(false)}
              className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
            >
              Criar Lista
            </button>
          </div>
        </form>
      </ResponsiveSheetModal>

      {/* =================================================================== */}
      {/* MODAL 2B: EDIT LIST (WITH SIMPLE BUTTON TYPE SELECTOR)              */}
      {/* =================================================================== */}
      <ResponsiveSheetModal
        isOpen={Boolean(editingList)}
        onClose={() => setEditingList(null)}
        title="Editar Lista"
        subtitle="Altere o tipo, o nome ou a descrição desta lista."
      >
        <form onSubmit={handleEditListSubmit} className="space-y-4">
          <div>
            <span className="block text-xs font-medium text-slate-300 mb-1.5">
              Tipo da Lista
            </span>
            <div className="grid grid-cols-3 gap-2">
              {LIST_TYPE_BUTTONS.map((btn) => {
                const isSelected = editListType === btn.id;
                return (
                  <button
                    key={btn.id}
                    type="button"
                    onClick={() => setEditListType(btn.id)}
                    className={`min-h-[42px] py-2 px-3 text-xs font-semibold rounded-xl border transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                        : 'bg-slate-800/70 text-slate-300 border-slate-700 hover:border-indigo-400'
                    }`}
                  >
                    {btn.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label
              htmlFor="edit-list-name"
              className="block text-xs font-medium text-slate-300 mb-1"
            >
              Nome da Lista
            </label>
            <input
              id="edit-list-name"
              type="text"
              required
              value={editListName}
              onChange={(e) => setEditListName(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label
              htmlFor="edit-list-desc"
              className="block text-xs font-medium text-slate-300 mb-1"
            >
              Descrição
            </label>
            <input
              id="edit-list-desc"
              type="text"
              value={editListDesc}
              onChange={(e) => setEditListDesc(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditingList(null)}
              className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
            >
              Salvar Alterações
            </button>
          </div>
        </form>
      </ResponsiveSheetModal>

      {/* =================================================================== */}
      {/* MODAL 2C: DELETE LIST CONFIRMATION                                  */}
      {/* =================================================================== */}
      <ResponsiveSheetModal
        isOpen={Boolean(deletingList)}
        onClose={() => setDeletingList(null)}
        title="Apagar Lista"
        subtitle={`Confirma a exclusão da lista "${deletingList?.name || ''}" e de seus itens?`}
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-400">
            Esta ação removerá a lista e todos os cards contidos nela.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setDeletingList(null)}
              className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleConfirmDeleteList}
              className="px-5 py-2.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg cursor-pointer"
            >
              Confirmar Exclusão
            </button>
          </div>
        </div>
      </ResponsiveSheetModal>

      {/* =================================================================== */}
      {/* MODAL 3: CREATE OR EDIT GENERIC ITEM                                */}
      {/* =================================================================== */}
      <ResponsiveSheetModal
        isOpen={isNewItemModalOpen}
        onClose={() => {
          setEditingItem(null);
          setIsNewItemModalOpen(false);
        }}
        title={
          editingItem
            ? `Editar Item: ${editingItem.name}`
            : `Novo Item em "${activeList?.name || 'Lista'}"`
        }
        subtitle="Informe o nome do item e escolha sua Categoria e Subcategoria."
      >
        <form onSubmit={handleSaveItemSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="new-item-name"
              className="block text-xs font-medium text-slate-300 mb-1"
            >
              Nome do Item
            </label>
            <input
              id="new-item-name"
              type="text"
              required
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              placeholder={
                activeFormListType === 'recorrente'
                  ? 'Ex: Feijão Carioca 1kg'
                  : activeFormListType === 'objetivo'
                  ? 'Ex: Ar-Condicionado Split Inverter 12000 BTUs'
                  : 'Ex: Cafeteira Italiana Inox'
              }
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="item-group-select"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Categoria Principal
              </label>
              <select
                id="item-group-select"
                value={selectedGroupId}
                onChange={(e) => handleGroupSelectChange(e.target.value)}
                className="w-full px-3 py-2.5 text-xs rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
              >
                {taxonomyGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="item-cat-select"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Subcategoria
              </label>
              <select
                id="item-cat-select"
                value={selectedCategoryId}
                onChange={(e) => setSelectedCategoryId(e.target.value)}
                className="w-full px-3 py-2.5 text-xs rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
              >
                {availableCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Fields for Recurring Item */}
          {activeFormListType === 'recorrente' && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label
                  htmlFor="item-curr-stock"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  Estoque Atual
                </label>
                <input
                  id="item-curr-stock"
                  type="number"
                  min="0"
                  value={currentStockInput}
                  onChange={(e) => setCurrentStockInput(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label
                  htmlFor="item-min-stock"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  Estoque Mínimo
                </label>
                <input
                  id="item-min-stock"
                  type="number"
                  min="0"
                  value={minStockInput}
                  onChange={(e) => setMinStockInput(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label
                  htmlFor="item-unit"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  Unidade
                </label>
                <select
                  id="item-unit"
                  value={unitInput}
                  onChange={(e) => setUnitInput(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
                >
                  <option value="un">un</option>
                  <option value="pct">pct</option>
                  <option value="kg">kg</option>
                  <option value="L">L</option>
                  <option value="cx">cx</option>
                </select>
              </div>
            </div>
          )}

          {/* Fields for Goal Item */}
          {activeFormListType === 'objetivo' && (
            <div>
              <label
                htmlFor="item-target-amount"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Valor Meta do Objetivo (R$)
              </label>
              <input
                id="item-target-amount"
                type="number"
                step="10"
                value={targetAmountInput}
                onChange={(e) => setTargetAmountInput(e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>
          )}

          {/* Fields for Wish Item */}
          {activeFormListType === 'desejo' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="item-est-price"
                    className="block text-xs font-medium text-slate-300 mb-1"
                  >
                    Preço Estimado (R$)
                  </label>
                  <input
                    id="item-est-price"
                    type="number"
                    value={estimatedPriceInput}
                    onChange={(e) => setEstimatedPriceInput(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label
                    htmlFor="item-priority"
                    className="block text-xs font-medium text-slate-300 mb-1"
                  >
                    Prioridade
                  </label>
                  <select
                    id="item-priority"
                    value={priorityInput}
                    onChange={(e) =>
                      setPriorityInput(e.target.value as 'Baixa' | 'Média' | 'Alta')
                    }
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="Alta">Alta</option>
                    <option value="Média">Média</option>
                    <option value="Baixa">Baixa</option>
                  </select>
                </div>
              </div>

              <div>
                <label
                  htmlFor="item-pros-cons"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  Prós e Contras / Avaliação
                </label>
                <input
                  id="item-pros-cons"
                  type="text"
                  value={prosConsInput}
                  onChange={(e) => setProsConsInput(e.target.value)}
                  placeholder="Vantagens e pontos de atenção..."
                  className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>
          )}

          <div>
            <label
              htmlFor="item-notes"
              className="block text-xs font-medium text-slate-300 mb-1"
            >
              Observações do Item
            </label>
            <input
              id="item-notes"
              type="text"
              value={itemNotes}
              onChange={(e) => setItemNotes(e.target.value)}
              placeholder="Especificações ou preferências..."
              className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setEditingItem(null);
                setIsNewItemModalOpen(false);
              }}
              className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
            >
              {editingItem ? 'Salvar Alterações' : 'Salvar Item'}
            </button>
          </div>
        </form>
      </ResponsiveSheetModal>

      {/* =================================================================== */}
      {/* MODAL 3B: DELETE ITEM CONFIRMATION                                  */}
      {/* =================================================================== */}
      <ResponsiveSheetModal
        isOpen={Boolean(deletingItem)}
        onClose={() => setDeletingItem(null)}
        title="Apagar Item"
        subtitle={`Deseja excluir o item "${deletingItem?.name || ''}"?`}
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-400">
            O card e seu histórico de compras serão removidos permanentemente desta lista.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setDeletingItem(null)}
              className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => {
                if (deletingItem) onDeleteItem(deletingItem.id);
                setDeletingItem(null);
              }}
              className="px-5 py-2.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg cursor-pointer"
            >
              Confirmar Exclusão
            </button>
          </div>
        </div>
      </ResponsiveSheetModal>

      {/* =================================================================== */}
      {/* MODAL 4: RECURRING CART PRODUCT INSTANCE (ITEM VS PRODUTO)          */}
      {/* =================================================================== */}
      <ResponsiveSheetModal
        isOpen={Boolean(cartModalState)}
        onClose={() => setCartModalState(null)}
        title={`Produto no Carrinho: ${cartModalState?.item.name || ''}`}
        subtitle="Informe a marca escolhida, o preço, a quantidade e o mercado para atualizar seu estoque e salvar no histórico de preços."
      >
        <form onSubmit={handleCartModalSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="prod-brand-input"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Marca Escolhida
              </label>
              <input
                id="prod-brand-input"
                type="text"
                required
                value={prodBrand}
                onChange={(e) => setProdBrand(e.target.value)}
                placeholder="Ex: Marca Tio João"
                className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label
                htmlFor="prod-store-input"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Mercado / Estabelecimento
              </label>
              <input
                id="prod-store-input"
                type="text"
                required
                value={prodStore}
                onChange={(e) => setProdStore(e.target.value)}
                placeholder="Ex: Mercado Extra"
                className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="prod-price-input"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Preço Unitário (R$)
              </label>
              <input
                id="prod-price-input"
                type="number"
                step="0.01"
                required
                value={prodPrice}
                onChange={(e) => setProdPrice(e.target.value)}
                placeholder="25.00"
                className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label
                htmlFor="prod-qty-input"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Quantidade Comprada
              </label>
              <input
                id="prod-qty-input"
                type="number"
                min="1"
                required
                value={prodQty}
                onChange={(e) => setProdQty(e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Receipt / Photo Upload */}
          <div className="p-3.5 rounded-xl bg-slate-800/60 border border-slate-700/80 flex items-center justify-between gap-3">
            <div className="text-xs">
              <span className="font-semibold text-slate-200 block">
                Anexar Cupom Fiscal ou Foto do Produto
              </span>
              <span className="text-slate-400">
                {prodReceiptUrl
                  ? 'Foto ou comprovante anexado com sucesso.'
                  : 'Opcional: envie imagem da nota fiscal ou etiqueta de preço.'}
              </span>
            </div>
            <label className="cursor-pointer px-3 py-2 text-xs font-medium rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 transition-colors flex items-center gap-1.5 shrink-0">
              <Upload className="w-3.5 h-3.5" />
              <span>{isUploadingReceipt ? 'Enviando...' : 'Anexar Foto'}</span>
              <input
                type="file"
                accept="image/*,.pdf"
                onChange={handleReceiptFileUpload}
                className="hidden"
              />
            </label>
          </div>

          {cartModalState?.advanceToConfirmed && onCreateExpenseFromPurchase && (
            <label className="p-3 rounded-xl bg-emerald-950/35 border border-emerald-800/60 flex items-center gap-2.5 cursor-pointer text-xs">
              <input
                type="checkbox"
                checked={createExpenseOnCartConfirm}
                onChange={(e) => setCreateExpenseOnCartConfirm(e.target.checked)}
                className="rounded border-emerald-500 text-emerald-500 focus:ring-emerald-500 bg-slate-900"
              />
              <span className="font-medium text-emerald-200">
                Abrir modal para lançar automaticamente como Despesa no Financeiro ao confirmar
              </span>
            </label>
          )}

          <div className="pt-2 flex items-center justify-between">
            <div className="text-xs font-mono tabular-nums text-slate-400">
              Total:{' '}
              <strong className="text-slate-100">
                {formatCurrencyBRL((Number(prodPrice) || 0) * (Number(prodQty) || 1))}
              </strong>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCartModalState(null)}
                className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg flex items-center gap-1.5 cursor-pointer"
              >
                <ShoppingCart className="w-3.5 h-3.5" />
                <span>
                  {cartModalState?.advanceToConfirmed
                    ? 'Confirmar Compra & Somar Estoque'
                    : 'Salvar no Carrinho'}
                </span>
              </button>
            </div>
          </div>
        </form>
      </ResponsiveSheetModal>

      {/* =================================================================== */}
      {/* MODAL 5: PRODUCT PURCHASE HISTORY                                   */}
      {/* =================================================================== */}
      <ResponsiveSheetModal
        isOpen={Boolean(historyModalItem)}
        onClose={() => setHistoryModalItem(null)}
        title={`Histórico de Preços: ${historyModalItem?.name || ''}`}
        subtitle="Veja todas as vezes que este item foi comprado, com marcas, mercados e valores."
        maxWidthClass="md:max-w-xl"
      >
        {historyModalItem && (
          <div className="space-y-4">
            {historyModalItem.productsHistory.length === 0 ? (
              <p className="text-xs text-slate-400 py-6 text-center">
                Nenhuma compra registrada para este item ainda.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-3 p-3.5 rounded-xl bg-slate-800/60 border border-slate-700/80 text-xs">
                  <div>
                    <span className="text-slate-400 block">Menor Preço</span>
                    <span className="font-mono font-bold text-emerald-400 text-sm">
                      {formatCurrencyBRL(
                        calculatePriceStats(historyModalItem.productsHistory)
                          .lowestPrice
                      )}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Preço Médio</span>
                    <span className="font-mono font-bold text-slate-100 text-sm">
                      {formatCurrencyBRL(
                        calculatePriceStats(historyModalItem.productsHistory)
                          .averagePrice
                      )}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Última Compra</span>
                    <span className="font-mono font-bold text-indigo-400 text-sm">
                      {formatCurrencyBRL(
                        calculatePriceStats(historyModalItem.productsHistory).lastPrice
                      )}
                    </span>
                  </div>
                </div>

                <div className="divide-y divide-slate-800 border-t border-b border-slate-800">
                  {historyModalItem.productsHistory.map((prod) => (
                    <div
                      key={prod.id}
                      className="py-3 flex items-center justify-between gap-3 text-xs"
                    >
                      <div>
                        <p className="font-semibold text-slate-100">
                          {prod.brand} · {prod.storeName}
                        </p>
                        <p className="text-slate-400 font-mono text-[11px]">
                          {new Date(prod.purchaseDate).toLocaleDateString('pt-BR')} ·{' '}
                          {prod.quantity}x {formatCurrencyBRL(prod.unitPrice)}
                        </p>
                      </div>
                      <div className="text-right font-mono tabular-nums">
                        <span className="font-bold text-slate-100 block">
                          {formatCurrencyBRL(prod.totalPrice)}
                        </span>
                        <span className="text-[11px] text-slate-400">
                          un: {formatCurrencyBRL(prod.unitPrice)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </ResponsiveSheetModal>

      {/* =================================================================== */}
      {/* MODAL 6: GOAL DEPOSIT (POUPANDO)                                    */}
      {/* =================================================================== */}
      <ResponsiveSheetModal
        isOpen={Boolean(depositModalItem)}
        onClose={() => setDepositModalItem(null)}
        title={`Novo Depósito: ${depositModalItem?.name || ''}`}
        subtitle="Registre um aporte financeiro para avançar a barra de progresso da meta."
      >
        <form onSubmit={handleDepositSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="deposit-amount-input"
              className="block text-xs font-medium text-slate-300 mb-1"
            >
              Valor do Depósito (R$)
            </label>
            <input
              id="deposit-amount-input"
              type="number"
              step="10"
              min="1"
              required
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label
              htmlFor="deposit-note-input"
              className="block text-xs font-medium text-slate-300 mb-1"
            >
              Identificação do Aporte
            </label>
            <input
              id="deposit-note-input"
              type="text"
              value={depositNote}
              onChange={(e) => setDepositNote(e.target.value)}
              placeholder="Ex: Transferência Reserva Mensal"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDepositModalItem(null)}
              className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="px-5 py-2.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg cursor-pointer"
            >
              Confirmar Depósito
            </button>
          </div>
        </form>
      </ResponsiveSheetModal>

      {/* =================================================================== */}
      {/* MODAL 7: GOAL RESEARCH QUOTE / LINK                                 */}
      {/* =================================================================== */}
      <ResponsiveSheetModal
        isOpen={Boolean(quoteModalItem)}
        onClose={() => setQuoteModalItem(null)}
        title={`Salvar Cotação: ${quoteModalItem?.name || ''}`}
        subtitle="Guarde links de lojas e preços pesquisados para tomada de decisão."
      >
        <form onSubmit={handleQuoteSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="quote-store"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Nome da Loja
              </label>
              <input
                id="quote-store"
                type="text"
                required
                value={quoteStore}
                onChange={(e) => setQuoteStore(e.target.value)}
                placeholder="Ex: Fast Shop / Amazon"
                className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label
                htmlFor="quote-price"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Preço Cotado (R$)
              </label>
              <input
                id="quote-price"
                type="number"
                step="0.01"
                required
                value={quotePrice}
                onChange={(e) => setQuotePrice(e.target.value)}
                placeholder="3490.00"
                className="w-full px-3.5 py-2 text-sm font-mono rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="quote-url"
              className="block text-xs font-medium text-slate-300 mb-1"
            >
              Link do Anúncio (URL)
            </label>
            <input
              id="quote-url"
              type="url"
              value={quoteUrl}
              onChange={(e) => setQuoteUrl(e.target.value)}
              placeholder="https://loja.com.br/produto"
              className="w-full px-3.5 py-2 text-sm font-mono rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label
              htmlFor="quote-notes"
              className="block text-xs font-medium text-slate-300 mb-1"
            >
              Condições (Cashback, Parcelamento, Frete)
            </label>
            <input
              id="quote-notes"
              type="text"
              value={quoteNotes}
              onChange={(e) => setQuoteNotes(e.target.value)}
              placeholder="Ex: 10% de desconto à vista no PIX"
              className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setQuoteModalItem(null)}
              className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
            >
              Adicionar Cotação
            </button>
          </div>
        </form>
      </ResponsiveSheetModal>

      {/* =================================================================== */}
      {/* MODAL 8: COMPLETE GOAL ACQUISITION REPORT (ADQUIRIDO)               */}
      {/* =================================================================== */}
      <ResponsiveSheetModal
        isOpen={Boolean(acquireGoalModalItem)}
        onClose={() => setAcquireGoalModalItem(null)}
        title={`Concluir Aquisição: ${acquireGoalModalItem?.name || ''}`}
        subtitle="Gere o relatório de valor final pago e registre o produto adquirido."
      >
        <form onSubmit={handleCompleteGoalSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="final-brand"
              className="block text-xs font-medium text-slate-300 mb-1"
            >
              Marca / Modelo Escolhido
            </label>
            <input
              id="final-brand"
              type="text"
              required
              value={finalBrandInput}
              onChange={(e) => setFinalBrandInput(e.target.value)}
              placeholder="Ex: Brastemp Gourmand Inox"
              className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="final-paid"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Valor Final Pago (R$)
              </label>
              <input
                id="final-paid"
                type="number"
                step="0.01"
                required
                value={finalPaidInput}
                onChange={(e) => setFinalPaidInput(e.target.value)}
                className="w-full px-3.5 py-2 text-sm font-mono rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label
                htmlFor="final-store"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Loja da Compra
              </label>
              <input
                id="final-store"
                type="text"
                required
                value={finalStoreInput}
                onChange={(e) => setFinalStoreInput(e.target.value)}
                placeholder="Ex: Fast Shop"
                className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {onCreateExpenseFromPurchase && (
            <label className="p-3 rounded-xl bg-emerald-950/35 border border-emerald-800/60 flex items-center gap-2.5 cursor-pointer text-xs">
              <input
                type="checkbox"
                checked={createExpenseOnGoalComplete}
                onChange={(e) => setCreateExpenseOnGoalComplete(e.target.checked)}
                className="rounded border-emerald-500 text-emerald-500 focus:ring-emerald-500 bg-slate-900"
              />
              <span className="font-medium text-emerald-200">
                Abrir modal para lançar este valor pago como Despesa no Financeiro
              </span>
            </label>
          )}

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAcquireGoalModalItem(null)}
              className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="px-5 py-2.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg cursor-pointer"
            >
              Gerar Relatório de Aquisição
            </button>
          </div>
        </form>
      </ResponsiveSheetModal>

      {/* =================================================================== */}
      {/* MODAL 9: CONVERT WISH TO GOAL                                       */}
      {/* =================================================================== */}
      <ResponsiveSheetModal
        isOpen={Boolean(convertWishModalItem)}
        onClose={() => setConvertWishModalItem(null)}
        title="Converter Desejo em Objetivo"
        subtitle={`Migrar "${convertWishModalItem?.name || ''}" para uma Lista de Objetivo com meta de economia.`}
      >
        <form onSubmit={handleConvertWishSubmit} className="space-y-4">
          <p className="text-xs text-slate-400 leading-relaxed">
            Ao converter este desejo, o card atual será arquivado na Wishlist e um novo card será criado na coluna{' '}
            <strong className="text-slate-100">
              Pesquisa / Cotação
            </strong>{' '}
            da Lista de Objetivo selecionada, mantendo o preço estimado de{' '}
            <strong className="font-mono text-slate-100">
              {formatCurrencyBRL(convertWishModalItem?.estimatedPrice)}
            </strong>
            .
          </p>

          <div>
            <label
              htmlFor="target-goal-list-select"
              className="block text-xs font-medium text-slate-300 mb-1"
            >
              Lista de Objetivo de Destino
            </label>
            <select
              id="target-goal-list-select"
              value={targetGoalListId}
              onChange={(e) => setTargetGoalListId(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:border-indigo-500"
            >
              {goalListsInWorkspace.map((gl) => (
                <option key={gl.id} value={gl.id}>
                  {gl.name}
                </option>
              ))}
            </select>
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConvertWishModalItem(null)}
              className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
            >
              Confirmar Migração para Objetivo
            </button>
          </div>
        </form>
      </ResponsiveSheetModal>
    </div>
  );
};
