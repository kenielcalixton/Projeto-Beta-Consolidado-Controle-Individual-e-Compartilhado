import {
  AcquisitionItem,
  GoalStage,
  ItemStage,
  ListType,
  ProductPurchase,
  RecurringStage,
  TaxonomyGroup,
  WishStage,
  Workspace,
} from '../types/acquisitions';

export const RECURRING_STAGES: { id: RecurringStage; label: string; subtitle: string }[] = [
  { id: 'estoque', label: 'Estoque', subtitle: 'Controle e alerta de mínima' },
  { id: 'comprar', label: 'A Comprar', subtitle: 'Reposição planejada' },
  { id: 'carrinho', label: 'Carrinho', subtitle: 'Cotação, marca e quantidade' },
  { id: 'conferido', label: 'Conferido', subtitle: 'Estoque atualizado e histórico' },
];

export const GOAL_STAGES: { id: GoalStage; label: string; subtitle: string }[] = [
  { id: 'pesquisa', label: 'Pesquisa / Cotação', subtitle: 'Links e comparativo de preços' },
  { id: 'poupando', label: 'Poupando', subtitle: 'Aportes e progresso da meta' },
  { id: 'pronto', label: 'Pronto para Executar', subtitle: 'Meta atingida para compra' },
  { id: 'adquirido', label: 'Adquirido', subtitle: 'Relatório de valor final' },
];

export const WISH_STAGES: { id: WishStage; label: string; subtitle: string }[] = [
  { id: 'ideia', label: 'Ideia', subtitle: 'Desejos e inspirações iniciais' },
  { id: 'avaliando', label: 'Avaliando', subtitle: 'Análise de custo-benefício' },
  { id: 'arquivado', label: 'Arquivado', subtitle: 'Descartados ou adiados' },
];

export function getStagesForListType(listType: ListType) {
  switch (listType) {
    case 'recorrente':
      return RECURRING_STAGES;
    case 'objetivo':
      return GOAL_STAGES;
    case 'desejo':
      return WISH_STAGES;
  }
}

export function getNextStage(listType: ListType, currentStage: ItemStage): ItemStage | null {
  const stages = getStagesForListType(listType).map((s) => s.id as ItemStage);
  const idx = stages.indexOf(currentStage);
  if (idx === -1 || idx >= stages.length - 1) return null;
  return stages[idx + 1];
}

export function getPreviousStage(listType: ListType, currentStage: ItemStage): ItemStage | null {
  const stages = getStagesForListType(listType).map((s) => s.id as ItemStage);
  const idx = stages.indexOf(currentStage);
  if (idx <= 0) return null;
  return stages[idx - 1];
}

export function isStockCritical(item: Pick<AcquisitionItem, 'currentStock' | 'minStock'>): boolean {
  const current = item.currentStock ?? 0;
  const min = item.minStock ?? 0;
  return current <= min;
}

export function calculateGoalProgress(savedAmount = 0, targetAmount = 0): number {
  if (targetAmount <= 0) return 0;
  const pct = (savedAmount / targetAmount) * 100;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

export function calculatePriceStats(history: ProductPurchase[]): {
  lastPrice: number | null;
  lowestPrice: number | null;
  averagePrice: number | null;
  lastBrand: string | null;
  lastStore: string | null;
} {
  if (!history || history.length === 0) {
    return {
      lastPrice: null,
      lowestPrice: null,
      averagePrice: null,
      lastBrand: null,
      lastStore: null,
    };
  }
  const sorted = [...history].sort(
    (a, b) => new Date(b.purchaseDate).getTime() - new Date(a.purchaseDate).getTime()
  );
  const prices = sorted.map((p) => p.unitPrice);
  const lowestPrice = Math.min(...prices);
  const sum = prices.reduce((acc, val) => acc + val, 0);
  const averagePrice = Number((sum / prices.length).toFixed(2));

  return {
    lastPrice: sorted[0].unitPrice,
    lowestPrice,
    averagePrice,
    lastBrand: sorted[0].brand,
    lastStore: sorted[0].storeName,
  };
}

// Advance a recurring item from 'carrinho' -> 'conferido', updating stock and generating a ProductPurchase record
export function confirmCartCheckout(
  item: AcquisitionItem,
  productInput: {
    brand: string;
    unitPrice: number;
    quantity: number;
    storeName: string;
    purchaseDate?: string;
    receiptUrl?: string;
    productPhotoUrl?: string;
  }
): { updatedItem: AcquisitionItem; newProduct: ProductPurchase } {
  const qty = Math.max(1, Number(productInput.quantity) || 1);
  const unitPrice = Math.max(0, Number(productInput.unitPrice) || 0);
  const totalPrice = Number((qty * unitPrice).toFixed(2));
  const purchaseDate = productInput.purchaseDate || new Date().toISOString();

  const newProduct: ProductPurchase = {
    id: `prod_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    itemId: item.id,
    brand: productInput.brand.trim(),
    unitPrice,
    quantity: qty,
    totalPrice,
    storeName: productInput.storeName.trim(),
    purchaseDate,
    receiptUrl: productInput.receiptUrl,
    productPhotoUrl: productInput.productPhotoUrl,
  };

  const updatedStock = (item.currentStock ?? 0) + qty;

  const updatedItem: AcquisitionItem = {
    ...item,
    stage: 'conferido',
    currentStock: updatedStock,
    cartDraft: {
      brand: newProduct.brand,
      unitPrice: newProduct.unitPrice,
      quantity: newProduct.quantity,
      storeName: newProduct.storeName,
      receiptUrl: newProduct.receiptUrl,
    },
    productsHistory: [newProduct, ...(item.productsHistory || [])],
    updatedAt: purchaseDate,
  };

  return { updatedItem, newProduct };
}

// Revert a recurring item from 'conferido' -> 'carrinho', restoring stock
export function revertConfirmedCheckout(item: AcquisitionItem): AcquisitionItem {
  if (item.listType !== 'recorrente' || item.stage !== 'conferido') {
    return item;
  }
  const lastQty = item.cartDraft?.quantity ?? item.productsHistory?.[0]?.quantity ?? 1;
  const restoredStock = Math.max(0, (item.currentStock ?? 0) - lastQty);

  return {
    ...item,
    stage: 'carrinho',
    currentStock: restoredStock,
    updatedAt: new Date().toISOString(),
  };
}

// Consume or adjust stock in Status 1 (Estoque); optionally auto-advance to Status 2 (A Comprar) if critical
export function adjustItemStock(
  item: AcquisitionItem,
  delta: number,
  autoMoveToBuyOnCritical = false
): AcquisitionItem {
  const newStock = Math.max(0, (item.currentStock ?? 0) + delta);
  const min = item.minStock ?? 1;
  const becameCritical = newStock <= min;

  const nextStage: ItemStage =
    autoMoveToBuyOnCritical && item.stage === 'estoque' && becameCritical
      ? 'comprar'
      : item.stage;

  return {
    ...item,
    currentStock: newStock,
    stage: nextStage,
    updatedAt: new Date().toISOString(),
  };
}

// Close the recurring cycle by returning a 'conferido' item back to 'estoque' with its updated balance and preserved history
export function returnConfirmedToStock(item: AcquisitionItem): AcquisitionItem {
  if (item.listType !== 'recorrente') return item;
  return {
    ...item,
    stage: 'estoque',
    cartDraft: undefined,
    updatedAt: new Date().toISOString(),
  };
}

// Detailed Final Financial Report for Status 4 (Adquirido) in Lista de Objetivo
export function calculateGoalFinalReport(item: AcquisitionItem): {
  budgetedAmount: number;
  savedAmount: number;
  paidAmount: number;
  differenceFromSaved: number;
  differenceFromBudget: number;
  status: 'economia' | 'exato' | 'acima';
} {
  const budgetedAmount = Number(item.targetAmount ?? 0);
  const savedAmount = Number(item.savedAmount ?? budgetedAmount);
  const paidAmount = Number(item.finalPaidAmount ?? budgetedAmount);
  const differenceFromSaved = Number((savedAmount - paidAmount).toFixed(2));
  const differenceFromBudget = Number((budgetedAmount - paidAmount).toFixed(2));

  let status: 'economia' | 'exato' | 'acima' = 'exato';
  if (differenceFromBudget > 0) status = 'economia';
  else if (differenceFromBudget < 0) status = 'acima';

  return {
    budgetedAmount,
    savedAmount,
    paidAmount,
    differenceFromSaved,
    differenceFromBudget,
    status,
  };
}

// Apply a deposit to a Goal item in 'poupando' stage
export function addGoalDeposit(
  item: AcquisitionItem,
  amount: number,
  authorEmail: string,
  note?: string
): AcquisitionItem {
  const validAmount = Math.max(0, Number(amount) || 0);
  const newSaved = Number(((item.savedAmount ?? 0) + validAmount).toFixed(2));
  const target = item.targetAmount ?? 0;

  const deposit = {
    id: `dep_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    amount: validAmount,
    date: new Date().toISOString(),
    note: note?.trim() || 'Depósito para meta',
    authorEmail,
  };

  // Automatically suggest or move to 'pronto' if saved >= target and target > 0
  const nextStage: GoalStage =
    target > 0 && newSaved >= target && item.stage === 'poupando' ? 'pronto' : (item.stage as GoalStage);

  return {
    ...item,
    stage: nextStage,
    savedAmount: newSaved,
    deposits: [deposit, ...(item.deposits || [])],
    updatedAt: new Date().toISOString(),
  };
}

// Convert a Wish ('desejo') item into a Goal ('objetivo') item in a target Goal list
export function convertWishToGoal(
  wishItem: AcquisitionItem,
  targetGoalListId: string
): { convertedGoalItem: AcquisitionItem; updatedWishItem: AcquisitionItem } {
  const now = new Date().toISOString();
  const newGoalId = `item_goal_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const initialQuotes = wishItem.inspirationUrl
    ? [
        {
          id: `quote_${Date.now()}`,
          storeName: 'Link de Referência (Desejo)',
          url: wishItem.inspirationUrl,
          price: wishItem.estimatedPrice ?? 0,
          notes: wishItem.prosAndCons || 'Migrado da Lista de Desejos',
          recordedAt: now,
        },
      ]
    : [];

  const convertedGoalItem: AcquisitionItem = {
    id: newGoalId,
    listId: targetGoalListId,
    workspaceId: wishItem.workspaceId,
    name: wishItem.name,
    groupId: wishItem.groupId,
    categoryId: wishItem.categoryId,
    listType: 'objetivo',
    stage: 'pesquisa',
    acceptedMemberEmails: [...wishItem.acceptedMemberEmails],
    notes: wishItem.notes || wishItem.prosAndCons || 'Convertido a partir da Lista de Desejos',
    targetAmount: wishItem.estimatedPrice ?? 1000,
    savedAmount: 0,
    quotes: initialQuotes,
    deposits: [],
    productsHistory: [],
    updatedAt: now,
  };

  const updatedWishItem: AcquisitionItem = {
    ...wishItem,
    stage: 'arquivado',
    convertedToGoalItemId: newGoalId,
    updatedAt: now,
  };

  return { convertedGoalItem, updatedWishItem };
}

// Filter workspaces where user email or UID is Accepted in the ACL
export function filterAcceptedWorkspaces(
  workspaces: Workspace[],
  userEmail: string,
  userUid?: string
): Workspace[] {
  const normalizedEmail = userEmail.trim().toLowerCase();
  return workspaces.filter((ws) => {
    const inEmailAcl = ws.acceptedMemberEmails?.some(
      (e) => e.trim().toLowerCase() === normalizedEmail
    );
    const inUidAcl = userUid ? ws.acceptedMemberUids?.includes(userUid) : false;
    const inMembersArray = ws.members?.some(
      (m) =>
        (m.email.trim().toLowerCase() === normalizedEmail || (userUid && m.uid === userUid)) &&
        m.status === 'Aceito'
    );
    return Boolean(inEmailAcl || inUidAcl || inMembersArray);
  });
}

// Filter workspaces where user has a Pending invitation
export function filterPendingInvitations(workspaces: Workspace[], userEmail: string): Workspace[] {
  const normalizedEmail = userEmail.trim().toLowerCase();
  return workspaces.filter((ws) =>
    ws.members?.some(
      (m) => m.email.trim().toLowerCase() === normalizedEmail && m.status === 'Pendente'
    )
  );
}

// Validate Taxonomy dependency: Category must belong to the selected Group
export function validateCategoryInGroup(
  groups: TaxonomyGroup[],
  groupId: string,
  categoryId: string
): boolean {
  const group = groups.find((g) => g.id === groupId);
  if (!group) return false;
  return group.categories.some((c) => c.id === categoryId && c.groupId === groupId);
}

export function formatCurrencyBRL(value: number | undefined | null): string {
  const num = Number(value ?? 0);
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(num);
}
