/**
 * Serviço de Listas de Aquisição e Copropriedade de Bens (Fase 8 - Arquitetura v3.1)
 *
 * Suporta modo Real (Firestore + Cloud Functions Admin SDK) e modo Demo (universalStorage + withDemoLock).
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './firebase';
import {
  AcquisitionList,
  AcquisitionListScopeType,
  AcquisitionListType,
  AcquisitionItem,
  AcquisitionItemUnit,
  AcquisitionItemPriority,
  AcquisitionPurchaseRecord,
  AcquisitionPurchaseDisbursement,
  AcquisitionPurchaseOwnershipShare,
  AcquisitionPurchaseOwnershipClassification,
  AcquisitionPurchaseLinkedExpenseType,
  StockMovementEvent,
  StockMovementEventType,
  AcquisitionQuoteEvent,
  AcquisitionDepositEvent,
  CentsInteger,
  DateString,
  ISO8601String,
} from '../types/financeV3';
import { validatePositiveCents } from '../utils/movementLedger';
import { universalStorage } from '../utils/universalStorage';
import { withDemoLock } from './ledgerService';

// ------------------------------------------------------------------------------
// CHAVES DE ARMAZENAMENTO DEMO
// ------------------------------------------------------------------------------
const DEMO_ACQ_LISTS_KEY = 'demo_acq_lists_v3';
const DEMO_ACQ_ITEMS_KEY = 'demo_acq_items_v3';
const DEMO_ACQ_PURCHASES_KEY = 'demo_acq_purchases_v3';
const DEMO_ACQ_STOCK_MOVEMENTS_KEY = 'demo_acq_stock_movements_v3';
const DEMO_ACQ_QUOTES_KEY = 'demo_acq_quotes_v3';
const DEMO_ACQ_DEPOSITS_KEY = 'demo_acq_deposits_v3';

// ------------------------------------------------------------------------------
// FUNÇÕES AUXILIARES DE HASH E ID DETERMINÍSTICO
// ------------------------------------------------------------------------------
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

function cleanUndefined<T extends Record<string, any>>(obj: T): Record<string, any> {
  const res: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      res[k] = v;
    }
  }
  return res;
}

export function generateAcquisitionListDocId(
  ownerOrSpaceId: string,
  name: string,
  type: AcquisitionListType,
  idempotencyKey?: string
): string {
  const cleanId = (ownerOrSpaceId || '').trim();
  const cleanName = (name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 16);
  const key = idempotencyKey?.trim() || `${cleanId}_${cleanName}_${type}`;
  const h = simpleHash(`acq_list:${cleanId}:${cleanName}:${type}:${key}`);
  return `list_${cleanName ? `${cleanName}_` : ''}${h}`;
}

export function generateAcquisitionItemDocId(
  listId: string,
  name: string,
  idempotencyKey?: string
): string {
  const cleanList = (listId || '').trim();
  const cleanName = (name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 16);
  const key = idempotencyKey?.trim() || `${cleanList}_${cleanName}`;
  const h = simpleHash(`acq_item:${cleanList}:${cleanName}:${key}`);
  return `item_${cleanName ? `${cleanName}_` : ''}${h}`;
}

export function generateAcquisitionPurchaseDocId(
  itemId: string,
  idempotencyKey: string
): string {
  const cleanItem = (itemId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const slug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  const h = simpleHash(`acq_purch:${cleanItem}:${cleanKey}`);
  return `pur_${slug ? `${slug}_` : ''}${h}`;
}

export function generateStockMovementDocId(
  itemId: string,
  idempotencyKey: string
): string {
  const cleanItem = (itemId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const slug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 16);
  const h = simpleHash(`acq_stock:${cleanItem}:${cleanKey}`);
  return `smov_${slug ? `${slug}_` : ''}${h}`;
}

export function generateQuoteDocId(
  itemId: string,
  idempotencyKey: string
): string {
  const cleanItem = (itemId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const slug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 16);
  const h = simpleHash(`acq_quote:${cleanItem}:${cleanKey}`);
  return `quot_${slug ? `${slug}_` : ''}${h}`;
}

export function generateDepositDocId(
  itemId: string,
  idempotencyKey: string
): string {
  const cleanItem = (itemId || '').trim();
  const cleanKey = (idempotencyKey || '').trim();
  const slug = cleanKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 16);
  const h = simpleHash(`acq_dep:${cleanItem}:${cleanKey}`);
  return `dep_${slug ? `${slug}_` : ''}${h}`;
}

// ------------------------------------------------------------------------------
// DEMO STORAGE LOADERS / SAVERS
// ------------------------------------------------------------------------------
function loadDemoAcqLists(): AcquisitionList[] {
  const raw = universalStorage.getItem(DEMO_ACQ_LISTS_KEY);
  return raw ? JSON.parse(raw) : [];
}

function saveDemoAcqLists(data: AcquisitionList[]): void {
  universalStorage.setItem(DEMO_ACQ_LISTS_KEY, JSON.stringify(data));
}

function loadDemoAcqItems(): AcquisitionItem[] {
  const raw = universalStorage.getItem(DEMO_ACQ_ITEMS_KEY);
  return raw ? JSON.parse(raw) : [];
}

function saveDemoAcqItems(data: AcquisitionItem[]): void {
  universalStorage.setItem(DEMO_ACQ_ITEMS_KEY, JSON.stringify(data));
}

function loadDemoAcqPurchases(): AcquisitionPurchaseRecord[] {
  const raw = universalStorage.getItem(DEMO_ACQ_PURCHASES_KEY);
  return raw ? JSON.parse(raw) : [];
}

function saveDemoAcqPurchases(data: AcquisitionPurchaseRecord[]): void {
  universalStorage.setItem(DEMO_ACQ_PURCHASES_KEY, JSON.stringify(data));
}

function loadDemoStockMovements(): StockMovementEvent[] {
  const raw = universalStorage.getItem(DEMO_ACQ_STOCK_MOVEMENTS_KEY);
  return raw ? JSON.parse(raw) : [];
}

function saveDemoStockMovements(data: StockMovementEvent[]): void {
  universalStorage.setItem(DEMO_ACQ_STOCK_MOVEMENTS_KEY, JSON.stringify(data));
}

function loadDemoQuotes(): AcquisitionQuoteEvent[] {
  const raw = universalStorage.getItem(DEMO_ACQ_QUOTES_KEY);
  return raw ? JSON.parse(raw) : [];
}

function saveDemoQuotes(data: AcquisitionQuoteEvent[]): void {
  universalStorage.setItem(DEMO_ACQ_QUOTES_KEY, JSON.stringify(data));
}

function loadDemoDeposits(): AcquisitionDepositEvent[] {
  const raw = universalStorage.getItem(DEMO_ACQ_DEPOSITS_KEY);
  return raw ? JSON.parse(raw) : [];
}

function saveDemoDeposits(data: AcquisitionDepositEvent[]): void {
  universalStorage.setItem(DEMO_ACQ_DEPOSITS_KEY, JSON.stringify(data));
}

// ------------------------------------------------------------------------------
// INPUT INTERFACES
// ------------------------------------------------------------------------------
export interface CreateAcquisitionListInput {
  name: string;
  description?: string;
  scopeType: AcquisitionListScopeType;
  type: AcquisitionListType;
  spaceId?: string;
  memberUids?: string[];
  idempotencyKey?: string;
}

export interface CreateAcquisitionItemInput {
  name: string;
  groupId: string;
  categoryId: string;
  currentStock?: number;
  minStock?: number;
  unit?: AcquisitionItemUnit;
  targetAmountCents?: CentsInteger;
  estimatedPriceCents?: CentsInteger;
  priority?: AcquisitionItemPriority;
  inspirationUrl?: string;
  notes?: string;
  idempotencyKey?: string;
}

export interface AcquisitionCheckoutInput {
  listId: string;
  itemId: string;
  physicalBuyerUid?: string;
  storeName: string;
  brand?: string;
  quantity: number;
  unitPriceCents: CentsInteger;
  itemsNetCents?: CentsInteger;
  shippingCents?: CentsInteger;
  feesCents?: CentsInteger;
  discountsCents?: CentsInteger;
  totalPaidCents: CentsInteger;
  purchaseDate?: DateString;
  receiptUrl?: string;
  ownershipClassification?: AcquisitionPurchaseOwnershipClassification;
  linkedExpenseId?: string;
  linkedExpenseType?: AcquisitionPurchaseLinkedExpenseType;
  disbursements: AcquisitionPurchaseDisbursement[];
  idempotencyKey?: string;
}

export interface AcquisitionCheckoutResult {
  purchase: AcquisitionPurchaseRecord;
  item: AcquisitionItem;
  isIdempotentReplay: boolean;
}

export interface RecordStockMovementInput {
  listId: string;
  itemId: string;
  movementType: StockMovementEventType;
  quantityDelta: number;
  justification?: string;
  idempotencyKey?: string;
}

export interface RecordStockMovementResult {
  movement: StockMovementEvent;
  item: AcquisitionItem;
  isIdempotentReplay: boolean;
}

export interface RecordAcquisitionQuoteInput {
  listId: string;
  itemId: string;
  storeName: string;
  priceCents: CentsInteger;
  url?: string;
  validUntil?: DateString;
  idempotencyKey?: string;
}

export interface RecordAcquisitionQuoteResult {
  quote: AcquisitionQuoteEvent;
  isIdempotentReplay: boolean;
}

export interface RecordAcquisitionDepositInput {
  listId: string;
  itemId: string;
  amountCents: CentsInteger;
  sourceAccountId?: string;
  depositDate?: DateString;
  notes?: string;
  idempotencyKey?: string;
}

export interface RecordAcquisitionDepositResult {
  deposit: AcquisitionDepositEvent;
  item: AcquisitionItem;
  isIdempotentReplay: boolean;
}

// ==============================================================================
// 1. GERENCIAMENTO DE LISTAS DE AQUISIÇÃO
// ==============================================================================

export async function createAcquisitionList(
  callerUid: string,
  input: CreateAcquisitionListInput,
  isDemo = false
): Promise<AcquisitionList> {
  if (!input.name || !input.name.trim()) {
    throw new Error('O nome da lista de aquisições é obrigatório.');
  }
  if (input.scopeType === 'shared' && !input.spaceId) {
    throw new Error('Listas compartilhadas exigem a vinculação de um spaceId.');
  }

  const now = new Date().toISOString();
  const ownerOrSpace = input.scopeType === 'individual' ? callerUid : input.spaceId!;
  const listId = generateAcquisitionListDocId(ownerOrSpace, input.name, input.type, input.idempotencyKey);

  const listDoc: AcquisitionList = {
    id: listId,
    scopeType: input.scopeType,
    ownerUid: input.scopeType === 'individual' ? callerUid : undefined,
    spaceId: input.scopeType === 'shared' ? input.spaceId : undefined,
    name: input.name.trim(),
    description: input.description?.trim(),
    type: input.type,
    memberUids: input.scopeType === 'shared'
      ? (input.memberUids && input.memberUids.length ? input.memberUids : [callerUid])
      : [callerUid],
    createdByUid: callerUid,
    createdAt: now,
  };

  if (!isDemo) {
    const listRef = doc(db, 'acquisition_lists', listId);
    await setDoc(listRef, cleanUndefined(listDoc));
    return listDoc;
  }

  return withDemoLock(async () => {
    const lists = loadDemoAcqLists();
    const existing = lists.find((l) => l.id === listId);
    if (existing) return existing;
    lists.push(listDoc);
    saveDemoAcqLists(lists);
    return listDoc;
  });
}

export async function getAcquisitionLists(
  callerUid: string,
  spaceId?: string,
  isDemo = false
): Promise<AcquisitionList[]> {
  if (!isDemo) {
    const listsRef = collection(db, 'acquisition_lists');
    let q = query(listsRef, where('scopeType', '==', spaceId ? 'shared' : 'individual'));
    if (spaceId) {
      q = query(listsRef, where('scopeType', '==', 'shared'), where('spaceId', '==', spaceId));
    } else {
      q = query(listsRef, where('scopeType', '==', 'individual'), where('ownerUid', '==', callerUid));
    }
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as AcquisitionList);
  }

  const lists = loadDemoAcqLists();
  if (spaceId) {
    return lists.filter((l) => l.scopeType === 'shared' && l.spaceId === spaceId);
  }
  return lists.filter((l) => l.scopeType === 'individual' && l.ownerUid === callerUid);
}

export async function getAcquisitionListById(
  listId: string,
  isDemo = false
): Promise<AcquisitionList | null> {
  if (!isDemo) {
    const snap = await getDoc(doc(db, 'acquisition_lists', listId));
    return snap.exists() ? (snap.data() as AcquisitionList) : null;
  }
  const lists = loadDemoAcqLists();
  return lists.find((l) => l.id === listId) || null;
}

// ==============================================================================
// 2. ITENS DE AQUISIÇÃO
// ==============================================================================

export async function createAcquisitionItem(
  callerUid: string,
  listId: string,
  input: CreateAcquisitionItemInput,
  isDemo = false
): Promise<AcquisitionItem> {
  if (!input.name || !input.name.trim()) {
    throw new Error('O nome do item é obrigatório.');
  }

  const list = await getAcquisitionListById(listId, isDemo);
  if (!list) {
    throw new Error(`Lista de aquisição "${listId}" não encontrada.`);
  }

  let defaultStage = 'estoque';
  if (list.type === 'objetivo') defaultStage = 'pesquisa';
  else if (list.type === 'desejo') defaultStage = 'ideia';

  const now = new Date().toISOString();
  const itemId = generateAcquisitionItemDocId(listId, input.name, input.idempotencyKey);

  const itemDoc: AcquisitionItem = {
    id: itemId,
    listId,
    scopeType: list.scopeType,
    ownerUid: list.ownerUid,
    spaceId: list.spaceId,
    name: input.name.trim(),
    groupId: input.groupId || 'group_default',
    categoryId: input.categoryId || 'cat_default',
    listType: list.type,
    stage: defaultStage,
    currentStock: input.currentStock ?? 0,
    minStock: input.minStock ?? 0,
    unit: input.unit || 'un',
    targetAmountCents: input.targetAmountCents,
    estimatedPriceCents: input.estimatedPriceCents,
    priority: input.priority || 'Média',
    inspirationUrl: input.inspirationUrl,
    notes: input.notes,
    createdByUid: callerUid,
    createdAt: now,
    updatedAt: now,
  };

  if (!isDemo) {
    const itemRef = doc(db, 'acquisition_lists', listId, 'items', itemId);
    await setDoc(itemRef, cleanUndefined(itemDoc));
    return itemDoc;
  }

  return withDemoLock(async () => {
    const items = loadDemoAcqItems();
    const existing = items.find((i) => i.id === itemId);
    if (existing) return existing;
    items.push(itemDoc);
    saveDemoAcqItems(items);
    return itemDoc;
  });
}

export async function getAcquisitionItems(
  listId: string,
  isDemo = false
): Promise<AcquisitionItem[]> {
  if (!isDemo) {
    const snap = await getDocs(collection(db, 'acquisition_lists', listId, 'items'));
    return snap.docs.map((d) => d.data() as AcquisitionItem);
  }
  const items = loadDemoAcqItems();
  return items.filter((i) => i.listId === listId);
}

export async function getAcquisitionItemById(
  listId: string,
  itemId: string,
  isDemo = false
): Promise<AcquisitionItem | null> {
  if (!isDemo) {
    const snap = await getDoc(doc(db, 'acquisition_lists', listId, 'items', itemId));
    return snap.exists() ? (snap.data() as AcquisitionItem) : null;
  }
  const items = loadDemoAcqItems();
  return items.find((i) => i.id === itemId && i.listId === listId) || null;
}

export async function updateAcquisitionItemStage(
  callerUid: string,
  listId: string,
  itemId: string,
  newStage: string,
  isDemo = false
): Promise<AcquisitionItem> {
  const item = await getAcquisitionItemById(listId, itemId, isDemo);
  if (!item) throw new Error('Item não encontrado.');

  const now = new Date().toISOString();
  const updatedItem: AcquisitionItem = {
    ...item,
    stage: newStage,
    updatedAt: now,
  };

  if (!isDemo) {
    const itemRef = doc(db, 'acquisition_lists', listId, 'items', itemId);
    await updateDoc(itemRef, { stage: newStage, updatedAt: now });
    return updatedItem;
  }

  return withDemoLock(async () => {
    const items = loadDemoAcqItems();
    const idx = items.findIndex((i) => i.id === itemId && i.listId === listId);
    if (idx !== -1) {
      items[idx] = updatedItem;
      saveDemoAcqItems(items);
    }
    return updatedItem;
  });
}

// ==============================================================================
// 3. CHECKOUT DE COMPRA E COPROPRIEDADE DE BENS
// ==============================================================================

export async function recordAcquisitionPurchase(
  callerUid: string,
  input: AcquisitionCheckoutInput,
  isDemo = false
): Promise<AcquisitionCheckoutResult> {
  if (!validatePositiveCents(input.totalPaidCents)) {
    throw new Error('totalPaidCents deve ser um inteiro estritamente positivo em centavos.');
  }
  if (!input.storeName || !input.storeName.trim()) {
    throw new Error('storeName é obrigatório.');
  }
  if (!input.disbursements || !input.disbursements.length) {
    throw new Error('Ao menos um desembolso é obrigatório.');
  }

  const cleanDate = input.purchaseDate || new Date().toISOString().slice(0, 10);
  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `idem_acq_${input.itemId}_${input.totalPaidCents}_${cleanDate}_${Date.now()}`;

  if (!isDemo) {
    const callable = httpsCallable<
      AcquisitionCheckoutInput & { idempotencyKey: string; purchaseDate: string },
      AcquisitionCheckoutResult
    >(functions, 'acquisitionCheckoutOfficial');

    const res = await callable({
      ...input,
      purchaseDate: cleanDate,
      idempotencyKey,
    });
    return res.data;
  }

  return withDemoLock(async () => {
    const items = loadDemoAcqItems();
    const itemIdx = items.findIndex((i) => i.id === input.itemId && i.listId === input.listId);
    if (itemIdx === -1) throw new Error('Item de aquisição não encontrado.');
    const item = items[itemIdx];

    const purchaseId = generateAcquisitionPurchaseDocId(input.itemId, idempotencyKey);
    const purchases = loadDemoAcqPurchases();
    const existing = purchases.find((p) => p.id === purchaseId || p.idempotencyKey === idempotencyKey);
    if (existing) {
      return { purchase: existing, item, isIdempotentReplay: true };
    }

    // Valida conservação contábil
    let sumDisbursements = 0;
    for (const d of input.disbursements) {
      if (!validatePositiveCents(d.disbursedAmountCents)) {
        throw new Error('Cada desembolso deve ser um inteiro positivo em centavos.');
      }
      sumDisbursements += d.disbursedAmountCents;
    }
    if (sumDisbursements !== input.totalPaidCents) {
      throw new Error(`A soma dos desembolsos (${sumDisbursements}) diverge do total pago (${input.totalPaidCents}).`);
    }

    const ownershipShares: AcquisitionPurchaseOwnershipShare[] = input.disbursements.map((d) => ({
      uid: d.funderUid,
      name: d.funderName || 'Participante',
      disbursedAmountCents: d.disbursedAmountCents,
      ownershipPercentage: Math.round(((d.disbursedAmountCents / input.totalPaidCents) * 100) * 10000) / 10000,
    }));

    const now = new Date().toISOString();
    const purchaseDoc: AcquisitionPurchaseRecord = {
      id: purchaseId,
      itemId: input.itemId,
      listId: input.listId,
      spaceId: item.spaceId,
      physicalBuyerUid: input.physicalBuyerUid || callerUid,
      authorUid: callerUid,
      storeName: input.storeName.trim(),
      brand: input.brand?.trim(),
      quantity: input.quantity,
      unitPriceCents: input.unitPriceCents,
      itemsNetCents: input.itemsNetCents ?? input.unitPriceCents * input.quantity,
      shippingCents: input.shippingCents ?? 0,
      feesCents: input.feesCents ?? 0,
      discountsCents: input.discountsCents ?? 0,
      totalPaidCents: input.totalPaidCents,
      purchaseDate: cleanDate,
      receiptUrl: input.receiptUrl,
      ownershipClassification: input.ownershipClassification || 'individual',
      disbursements: input.disbursements,
      ownershipShares,
      linkedExpenseId: input.linkedExpenseId || `exp_acq_${Date.now()}`,
      linkedExpenseType: input.linkedExpenseType || 'personal',
      idempotencyKey,
      createdAt: now,
    };

    purchases.push(purchaseDoc);
    saveDemoAcqPurchases(purchases);

    // Atualiza estado do item
    let newStock = item.currentStock || 0;
    let newStage = item.stage;
    let finalPaid = item.finalPaidAmountCents;

    if (item.listType === 'recorrente') {
      newStock += input.quantity;
      newStage = 'conferido';

      // Registra movimentação de estoque
      const smovs = loadDemoStockMovements();
      smovs.push({
        id: generateStockMovementDocId(item.id, `${idempotencyKey}_smov`),
        itemId: item.id,
        movementType: 'purchase_inflow',
        quantityDelta: input.quantity,
        previousStock: item.currentStock || 0,
        newStock,
        authorUid: callerUid,
        justification: `Compra em ${input.storeName}`,
        createdAt: now,
      });
      saveDemoStockMovements(smovs);
    } else if (item.listType === 'objetivo') {
      newStage = 'adquirido';
      finalPaid = input.totalPaidCents;
    } else if (item.listType === 'desejo') {
      newStage = 'adquirido';
    }

    const updatedItem: AcquisitionItem = {
      ...item,
      currentStock: newStock,
      stage: newStage,
      finalPaidAmountCents: finalPaid,
      updatedAt: now,
    };
    items[itemIdx] = updatedItem;
    saveDemoAcqItems(items);

    return {
      purchase: purchaseDoc,
      item: updatedItem,
      isIdempotentReplay: false,
    };
  });
}

export async function getAcquisitionPurchases(
  listId: string,
  itemId: string,
  isDemo = false
): Promise<AcquisitionPurchaseRecord[]> {
  if (!isDemo) {
    const snap = await getDocs(
      collection(db, 'acquisition_lists', listId, 'items', itemId, 'purchases')
    );
    return snap.docs.map((d) => d.data() as AcquisitionPurchaseRecord);
  }
  const purchases = loadDemoAcqPurchases();
  return purchases.filter((p) => p.itemId === itemId && p.listId === listId);
}

// ==============================================================================
// 4. MOVIMENTAÇÃO DE ESTOQUE
// ==============================================================================

export async function recordStockMovement(
  callerUid: string,
  input: RecordStockMovementInput,
  isDemo = false
): Promise<RecordStockMovementResult> {
  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `idem_smov_${input.itemId}_${input.quantityDelta}_${Date.now()}`;

  if (!isDemo) {
    const callable = httpsCallable<
      RecordStockMovementInput & { idempotencyKey: string },
      RecordStockMovementResult
    >(functions, 'recordStockMovementOfficial');

    const res = await callable({
      ...input,
      idempotencyKey,
    });
    return res.data;
  }

  return withDemoLock(async () => {
    const items = loadDemoAcqItems();
    const itemIdx = items.findIndex((i) => i.id === input.itemId && i.listId === input.listId);
    if (itemIdx === -1) throw new Error('Item não encontrado.');
    const item = items[itemIdx];

    const smovId = generateStockMovementDocId(input.itemId, idempotencyKey);
    const smovs = loadDemoStockMovements();
    const existing = smovs.find((s) => s.id === smovId);
    if (existing) return { movement: existing, item, isIdempotentReplay: true };

    const previousStock = item.currentStock || 0;
    const newStock = Math.max(0, previousStock + input.quantityDelta);
    const now = new Date().toISOString();

    const movementDoc: StockMovementEvent = {
      id: smovId,
      itemId: input.itemId,
      movementType: input.movementType,
      quantityDelta: input.quantityDelta,
      previousStock,
      newStock,
      authorUid: callerUid,
      justification: input.justification,
      createdAt: now,
    };
    smovs.push(movementDoc);
    saveDemoStockMovements(smovs);

    const updatedItem: AcquisitionItem = {
      ...item,
      currentStock: newStock,
      updatedAt: now,
    };
    items[itemIdx] = updatedItem;
    saveDemoAcqItems(items);

    return { movement: movementDoc, item: updatedItem, isIdempotentReplay: false };
  });
}

export async function getStockMovements(
  listId: string,
  itemId: string,
  isDemo = false
): Promise<StockMovementEvent[]> {
  if (!isDemo) {
    const snap = await getDocs(
      collection(db, 'acquisition_lists', listId, 'items', itemId, 'stock_movements')
    );
    return snap.docs.map((d) => d.data() as StockMovementEvent);
  }
  const smovs = loadDemoStockMovements();
  return smovs.filter((s) => s.itemId === itemId);
}

// ==============================================================================
// 5. COTAÇÕES DE PREÇO
// ==============================================================================

export async function recordAcquisitionQuote(
  callerUid: string,
  input: RecordAcquisitionQuoteInput,
  isDemo = false
): Promise<RecordAcquisitionQuoteResult> {
  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `idem_quot_${input.itemId}_${input.priceCents}_${Date.now()}`;

  if (!isDemo) {
    const callable = httpsCallable<
      RecordAcquisitionQuoteInput & { idempotencyKey: string },
      RecordAcquisitionQuoteResult
    >(functions, 'recordAcquisitionQuoteOfficial');

    const res = await callable({
      ...input,
      idempotencyKey,
    });
    return res.data;
  }

  return withDemoLock(async () => {
    const quoteId = generateQuoteDocId(input.itemId, idempotencyKey);
    const quotes = loadDemoQuotes();
    const existing = quotes.find((q) => q.id === quoteId);
    if (existing) return { quote: existing, isIdempotentReplay: true };

    const quoteDoc: AcquisitionQuoteEvent = {
      id: quoteId,
      itemId: input.itemId,
      storeName: input.storeName.trim(),
      priceCents: input.priceCents,
      url: input.url,
      validUntil: input.validUntil,
      authorUid: callerUid,
      createdAt: new Date().toISOString(),
    };
    quotes.push(quoteDoc);
    saveDemoQuotes(quotes);

    return { quote: quoteDoc, isIdempotentReplay: false };
  });
}

export async function getAcquisitionQuotes(
  listId: string,
  itemId: string,
  isDemo = false
): Promise<AcquisitionQuoteEvent[]> {
  if (!isDemo) {
    const snap = await getDocs(
      collection(db, 'acquisition_lists', listId, 'items', itemId, 'quotes')
    );
    return snap.docs.map((d) => d.data() as AcquisitionQuoteEvent);
  }
  const quotes = loadDemoQuotes();
  return quotes.filter((q) => q.itemId === itemId);
}

// ==============================================================================
// 6. APORTES DE POUPANÇA (DEPÓSITOS)
// ==============================================================================

export async function recordAcquisitionDeposit(
  callerUid: string,
  input: RecordAcquisitionDepositInput,
  isDemo = false
): Promise<RecordAcquisitionDepositResult> {
  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `idem_dep_${input.itemId}_${input.amountCents}_${Date.now()}`;

  if (!isDemo) {
    const callable = httpsCallable<
      RecordAcquisitionDepositInput & { idempotencyKey: string },
      RecordAcquisitionDepositResult
    >(functions, 'recordAcquisitionDepositOfficial');

    const res = await callable({
      ...input,
      idempotencyKey,
    });
    return res.data;
  }

  return withDemoLock(async () => {
    const items = loadDemoAcqItems();
    const itemIdx = items.findIndex((i) => i.id === input.itemId && i.listId === input.listId);
    if (itemIdx === -1) throw new Error('Item não encontrado.');
    const item = items[itemIdx];

    const depositId = generateDepositDocId(input.itemId, idempotencyKey);
    const deposits = loadDemoDeposits();
    const existing = deposits.find((d) => d.id === depositId);
    if (existing) return { deposit: existing, item, isIdempotentReplay: true };

    const now = new Date().toISOString();
    const depositDoc: AcquisitionDepositEvent = {
      id: depositId,
      itemId: input.itemId,
      contributorUid: callerUid,
      amountCents: input.amountCents,
      sourceAccountId: input.sourceAccountId || '',
      depositDate: input.depositDate || now.slice(0, 10),
      notes: input.notes,
      createdAt: now,
    };
    deposits.push(depositDoc);
    saveDemoDeposits(deposits);

    const newSaved = (item.savedAmountCents || 0) + input.amountCents;
    let newStage = item.stage;
    if (item.targetAmountCents && newSaved >= item.targetAmountCents) {
      newStage = 'pronto';
    } else if (newSaved > 0 && item.stage === 'pesquisa') {
      newStage = 'poupando';
    }

    const updatedItem: AcquisitionItem = {
      ...item,
      savedAmountCents: newSaved,
      stage: newStage,
      updatedAt: now,
    };
    items[itemIdx] = updatedItem;
    saveDemoAcqItems(items);

    return { deposit: depositDoc, item: updatedItem, isIdempotentReplay: false };
  });
}

export async function getAcquisitionDeposits(
  listId: string,
  itemId: string,
  isDemo = false
): Promise<AcquisitionDepositEvent[]> {
  if (!isDemo) {
    const snap = await getDocs(
      collection(db, 'acquisition_lists', listId, 'items', itemId, 'deposits')
    );
    return snap.docs.map((d) => d.data() as AcquisitionDepositEvent);
  }
  const deposits = loadDemoDeposits();
  return deposits.filter((d) => d.itemId === itemId);
}
