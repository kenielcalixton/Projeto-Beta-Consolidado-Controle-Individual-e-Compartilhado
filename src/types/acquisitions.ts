export type MemberStatus = 'Pendente' | 'Aceito' | 'Recusado';

export interface WorkspaceMember {
  uid?: string;
  email: string;
  name?: string;
  role: 'Admin' | 'Membro';
  status: MemberStatus;
  rejectionReason?: string;
  rejectionNote?: string;
  respondedAt?: string;
  avatarUrl?: string;
}

export interface Workspace {
  id: string;
  name: string;
  description: string;
  type: 'Individual' | 'Compartilhado';
  ownerUid: string;
  ownerEmail: string;
  acceptedMemberEmails: string[]; // Used for Firestore ACL array-contains queries
  acceptedMemberUids: string[];   // Used for Firestore ACL UID queries
  members: WorkspaceMember[];
  monthlyBudget?: number;
  createdAt: string;
}

export interface TaxonomyCategory {
  id: string;
  groupId: string;
  name: string;
  description?: string;
}

export interface TaxonomyGroup {
  id: string;
  name: string;
  code: string;
  description: string;
  categories: TaxonomyCategory[];
}

export type ListType = 'recorrente' | 'objetivo' | 'desejo';

// State Machine Columns per List Type
export type RecurringStage = 'estoque' | 'comprar' | 'carrinho' | 'conferido';
export type GoalStage = 'pesquisa' | 'poupando' | 'pronto' | 'adquirido';
export type WishStage = 'ideia' | 'avaliando' | 'arquivado';

export type ItemStage = RecurringStage | GoalStage | WishStage;

export interface AcquisitionList {
  id: string;
  workspaceId: string;
  name: string;
  type: ListType;
  description: string;
  acceptedMemberEmails: string[];
  createdAt: string;
}

// Product Instance (Subcollection `items/{itemId}/products`)
export interface ProductPurchase {
  id: string;
  itemId: string;
  brand: string;
  unitPrice: number;
  quantity: number;
  totalPrice: number;
  storeName: string;
  purchaseDate: string;
  receiptUrl?: string;
  productPhotoUrl?: string;
  notes?: string;
}

// Quote / Link for Goal Research
export interface GoalQuote {
  id: string;
  storeName: string;
  url: string;
  price: number;
  notes?: string;
  recordedAt: string;
}

// Deposit record for Goal Saving
export interface GoalDeposit {
  id: string;
  amount: number;
  date: string;
  note?: string;
  authorEmail: string;
}

// Generic Item concept
export interface AcquisitionItem {
  id: string;
  listId: string;
  workspaceId: string;
  name: string; // Ex: "Arroz 5kg", "Geladeira Inverter", "Fone Cancelamento de Ruído"
  groupId: string;
  categoryId: string;
  listType: ListType;
  stage: ItemStage;
  acceptedMemberEmails: string[]; // ACL filter
  notes?: string;

  // Fields for Lista Recorrente
  currentStock?: number;
  minStock?: number;
  unit?: string; // 'un', 'kg', 'L', 'pct', 'cx'
  cartDraft?: {
    brand: string;
    unitPrice: number;
    quantity: number;
    storeName: string;
    receiptUrl?: string;
  };

  // Fields for Lista de Objetivo
  targetAmount?: number;
  savedAmount?: number;
  finalPaidAmount?: number;
  acquiredStore?: string;
  acquiredDate?: string;
  receiptUrl?: string;
  quotes?: GoalQuote[];
  deposits?: GoalDeposit[];

  // Fields for Lista de Desejo
  estimatedPrice?: number;
  priority?: 'Baixa' | 'Média' | 'Alta';
  inspirationUrl?: string;
  prosAndCons?: string;
  convertedToGoalItemId?: string;

  // Subcollection history cached in memory/doc for fast display
  productsHistory: ProductPurchase[];
  updatedAt: string;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  isAdmin?: boolean;
}
