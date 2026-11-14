import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  updateProfile,
  User,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  Unsubscribe,
} from 'firebase/firestore';
import {
  ref,
  uploadBytes,
  getDownloadURL,
} from 'firebase/storage';
import {
  app,
  auth,
  db,
  storage,
  firebaseConfig,
  MASTER_ADMIN_UID,
} from './firebase';
import {
  AcquisitionItem,
  AcquisitionList,
  ProductPurchase,
  TaxonomyGroup,
  UserProfile,
  Workspace,
} from '../types/acquisitions';

/**
 * Remove profundamente chaves com valor `undefined` (Firestore rejeita `undefined` em setDoc/updateDoc).
 */
export function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry !== undefined)
      .map((entry) => stripUndefinedDeep(entry)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        result[k] = stripUndefinedDeep(v);
      }
    }
    return result as T;
  }
  return value;
}

export { app, auth, db, storage, firebaseConfig };

export const ADMIN_USER_UID = MASTER_ADMIN_UID;
export const LEGACY_ADMIN_UIDS = [
  MASTER_ADMIN_UID,
  'wAUPqTjSmOMV3S8XlaLlv46QK463',
  'cFlLuuez1TMfNhsNFKGpjQ8qYSG3',
];

export function isAcquisitionAdminUid(uid?: string | null): boolean {
  if (!uid) return false;
  return LEGACY_ADMIN_UIDS.includes(uid.trim());
}

// ============================================================================
// 1. AUTENTICAÇÃO (FIREBASE AUTH - LOGIN, CRIAÇÃO DE CONTA E SENHA)
// ============================================================================

export async function loginWithEmail(email: string, password: string): Promise<UserProfile> {
  const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
  const profile = mapFirebaseUserToProfile(credential.user);
  await upsertUserDocument(profile);
  return profile;
}

export async function registerWithEmail(
  name: string,
  email: string,
  password: string
): Promise<UserProfile> {
  const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
  if (name.trim()) {
    await updateProfile(credential.user, { displayName: name.trim() });
  }
  const profile: UserProfile = {
    uid: credential.user.uid,
    email: credential.user.email || email.trim(),
    displayName: name.trim() || email.split('@')[0],
    isAdmin: isAcquisitionAdminUid(credential.user.uid),
  };
  await upsertUserDocument(profile);
  return profile;
}

export async function resetPasswordWithEmail(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email.trim());
}

export async function logoutFirebase(): Promise<void> {
  await firebaseSignOut(auth);
}

export function subscribeToAuthChanges(callback: (user: UserProfile | null) => void) {
  return onAuthStateChanged(auth, (firebaseUser) => {
    if (!firebaseUser) {
      callback(null);
      return;
    }
    callback(mapFirebaseUserToProfile(firebaseUser));
  });
}

function mapFirebaseUserToProfile(user: User): UserProfile {
  return {
    uid: user.uid,
    email: user.email || '',
    displayName: user.displayName || user.email?.split('@')[0] || 'Usuário',
    avatarUrl: user.photoURL || undefined,
    isAdmin: isAcquisitionAdminUid(user.uid),
  };
}

// ============================================================================
// 2. COLEÇÃO `users` & FUNÇÕES DO AMBIENTE ADMIN
// ============================================================================

export async function upsertUserDocument(user: UserProfile): Promise<void> {
  try {
    const userRef = doc(db, 'users', user.uid);
    await setDoc(
      userRef,
      stripUndefinedDeep({
        uid: user.uid,
        email: user.email.toLowerCase(),
        displayName: user.displayName,
        name: user.displayName,
        avatarUrl: user.avatarUrl || null,
        isAdmin: isAcquisitionAdminUid(user.uid) || Boolean(user.isAdmin),
        updatedAt: new Date().toISOString(),
      }),
      { merge: true }
    );
  } catch (err) {
    console.warn('[Firestore / Offline fallback] upsertUserDocument:', err);
  }
}

export async function fetchAllUsersFromFirestore(): Promise<UserProfile[]> {
  try {
    const usersRef = collection(db, 'users');
    const snapshot = await getDocs(usersRef);
    return snapshot.docs.map((d) => {
      const data = d.data();
      const uid = data.uid || d.id;
      return {
        uid,
        email: data.email || '',
        displayName: data.displayName || data.name || 'Usuário',
        avatarUrl: data.avatarUrl || undefined,
        isAdmin: isAcquisitionAdminUid(uid) || Boolean(data.isAdmin),
      };
    });
  } catch {
    return [];
  }
}

export async function fetchAllWorkspacesFromFirestore(): Promise<Workspace[]> {
  try {
    const workspacesRef = collection(db, 'workspaces');
    const snapshot = await getDocs(workspacesRef);
    return snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Workspace, 'id'>) }));
  } catch {
    return [];
  }
}

export async function syncAllDataToFirestore(payload: {
  users: UserProfile[];
  workspaces: Workspace[];
  lists: AcquisitionList[];
  items: AcquisitionItem[];
  taxonomyGroups: TaxonomyGroup[];
}): Promise<{ syncedCount: number }> {
  let syncedCount = 0;

  for (const u of payload.users) {
    await upsertUserDocument(u);
    syncedCount++;
  }
  for (const g of payload.taxonomyGroups) {
    await saveTaxonomyGroupToFirestore(g);
    syncedCount++;
  }
  for (const w of payload.workspaces) {
    await saveWorkspaceToFirestore(w);
    syncedCount++;
  }
  for (const l of payload.lists) {
    await saveListToFirestore(l);
    syncedCount++;
  }
  for (const i of payload.items) {
    await saveItemToFirestore(i);
    syncedCount++;
  }

  return { syncedCount };
}

// ============================================================================
// 3. COLEÇÃO `workspaces`
// ============================================================================

export async function fetchAcceptedWorkspacesFromFirestore(
  userEmail: string
): Promise<Workspace[]> {
  const normalizedEmail = userEmail.trim().toLowerCase();
  const workspacesRef = collection(db, 'workspaces');
  const aclQuery = query(
    workspacesRef,
    where('acceptedMemberEmails', 'array-contains', normalizedEmail)
  );
  const snapshot = await getDocs(aclQuery);
  return snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Workspace, 'id'>) }));
}

export async function saveWorkspaceToFirestore(workspace: Workspace): Promise<void> {
  try {
    const wsRef = doc(db, 'workspaces', workspace.id);
    await setDoc(wsRef, stripUndefinedDeep(workspace), { merge: true });
  } catch (err) {
    console.warn('[Firestore / Offline fallback] saveWorkspaceToFirestore:', err);
  }
}

export async function deleteWorkspaceFromFirestore(workspaceId: string): Promise<void> {
  try {
    const wsRef = doc(db, 'workspaces', workspaceId);
    await deleteDoc(wsRef);
  } catch (err) {
    console.warn('[Firestore / Offline fallback] deleteWorkspaceFromFirestore:', err);
  }
}

// ============================================================================
// 4. COLEÇÃO `acquisition_lists`
// ============================================================================

export async function fetchIndividualListsFromFirestore(
  ownerUid: string
): Promise<AcquisitionList[]> {
  if (!ownerUid) return [];
  try {
    const listsRef = collection(db, 'acquisition_lists');
    const q = query(
      listsRef,
      where('scopeType', '==', 'individual'),
      where('ownerUid', '==', ownerUid)
    );
    const snapshot = await getDocs(q);
    return snapshot.docs
      .filter((d) => !d.data().isArchived)
      .map((d) => ({ id: d.id, ...(d.data() as Omit<AcquisitionList, 'id'>) }));
  } catch (err) {
    console.warn('[Firestore] fetchIndividualListsFromFirestore:', err);
    return [];
  }
}

export async function fetchSharedListsFromFirestore(
  spaceId: string
): Promise<AcquisitionList[]> {
  if (!spaceId) return [];
  try {
    const listsRef = collection(db, 'acquisition_lists');
    const q = query(
      listsRef,
      where('scopeType', '==', 'shared'),
      where('spaceId', '==', spaceId)
    );
    const snapshot = await getDocs(q);
    return snapshot.docs
      .filter((d) => !d.data().isArchived)
      .map((d) => ({ id: d.id, ...(d.data() as Omit<AcquisitionList, 'id'>) }));
  } catch (err) {
    console.warn('[Firestore] fetchSharedListsFromFirestore:', err);
    return [];
  }
}

export async function fetchItemsForListFromFirestore(
  listId: string
): Promise<AcquisitionItem[]> {
  if (!listId) return [];
  try {
    const itemsRef = collection(db, 'acquisition_lists', listId, 'items');
    const snapshot = await getDocs(itemsRef);
    return snapshot.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<AcquisitionItem, 'id'>),
    }));
  } catch (err) {
    console.warn('[Firestore] fetchItemsForListFromFirestore:', err);
    return [];
  }
}

export function subscribeToIndividualLists(
  ownerUid: string,
  onLists: (lists: AcquisitionList[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!ownerUid) return () => {};
  const listsRef = collection(db, 'acquisition_lists');
  const q = query(
    listsRef,
    where('scopeType', '==', 'individual'),
    where('ownerUid', '==', ownerUid)
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const data = snapshot.docs
        .filter((d) => !d.data().isArchived)
        .map((d) => ({ id: d.id, ...(d.data() as Omit<AcquisitionList, 'id'>) }));
      onLists(data);
    },
    (err) => {
      console.warn('[Firestore] subscribeToIndividualLists:', err);
      onError?.(err);
    }
  );
}

export function subscribeToSharedLists(
  spaceId: string,
  onLists: (lists: AcquisitionList[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!spaceId) return () => {};
  const listsRef = collection(db, 'acquisition_lists');
  const q = query(
    listsRef,
    where('scopeType', '==', 'shared'),
    where('spaceId', '==', spaceId)
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const data = snapshot.docs
        .filter((d) => !d.data().isArchived)
        .map((d) => ({ id: d.id, ...(d.data() as Omit<AcquisitionList, 'id'>) }));
      onLists(data);
    },
    (err) => {
      console.warn('[Firestore] subscribeToSharedLists:', err);
      onError?.(err);
    }
  );
}

export function subscribeToListItems(
  listId: string,
  onItems: (items: AcquisitionItem[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!listId) return () => {};
  const itemsRef = collection(db, 'acquisition_lists', listId, 'items');
  return onSnapshot(
    itemsRef,
    (snapshot) => {
      const data = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<AcquisitionItem, 'id'>),
      }));
      onItems(data);
    },
    (err) => {
      console.warn(`[Firestore] subscribeToListItems(${listId}):`, err);
      onError?.(err);
    }
  );
}

export async function fetchListsForWorkspaceFromFirestore(
  workspaceId: string,
  userEmail: string
): Promise<AcquisitionList[]> {
  const normalizedEmail = userEmail.trim().toLowerCase();
  const listsRef = collection(db, 'acquisition_lists');
  const aclQuery = query(
    listsRef,
    where('workspaceId', '==', workspaceId),
    where('acceptedMemberEmails', 'array-contains', normalizedEmail)
  );
  const snapshot = await getDocs(aclQuery);
  return snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AcquisitionList, 'id'>) }));
}

export async function saveListToFirestore(list: AcquisitionList): Promise<void> {
  const listRef = doc(db, 'acquisition_lists', list.id);
  const currentUser = auth.currentUser;
  const isShared = list.scopeType === 'shared' && Boolean(list.spaceId);
  const docData = stripUndefinedDeep({
    ...list,
    scopeType: isShared ? 'shared' : 'individual',
    spaceId: isShared ? list.spaceId : null,
    ownerUid: list.ownerUid || currentUser?.uid || '',
    updatedAt: new Date().toISOString(),
  });
  await setDoc(listRef, docData, { merge: true });
}

export async function deleteListFromFirestore(listId: string): Promise<void> {
  const listRef = doc(db, 'acquisition_lists', listId);
  await updateDoc(listRef, { isArchived: true, deletedAt: new Date().toISOString() });
}

// ============================================================================
// 5. COLEÇÃO `items` E SUBCOLEÇÃO `items/{itemId}/purchases` (HISTÓRICO)
// ============================================================================

export async function fetchItemsForWorkspaceFromFirestore(
  workspaceId: string,
  userEmail: string
): Promise<AcquisitionItem[]> {
  return [];
}

export async function saveItemToFirestore(item: AcquisitionItem): Promise<void> {
  if (!item.listId) {
    throw new Error('Item sem listId associado não pode ser salvo.');
  }
  const itemRef = doc(db, 'acquisition_lists', item.listId, 'items', item.id);
  const currentUser = auth.currentUser;
  const rawPayload: Record<string, unknown> = {
    ...item,
    createdByUid: item.createdByUid || currentUser?.uid || '',
    updatedAt: new Date().toISOString(),
  };
  if (item.cartDraft === undefined) {
    rawPayload.cartDraft = null;
  }
  const docData = stripUndefinedDeep(rawPayload);
  await setDoc(itemRef, docData, { merge: true });
}

export async function recordProductInSubcollection(
  item: AcquisitionItem,
  _product: ProductPurchase
): Promise<void> {
  if (!item.listId) return;
  const itemRef = doc(db, 'acquisition_lists', item.listId, 'items', item.id);
  const payload = stripUndefinedDeep({
    stage: item.stage,
    currentStock: item.currentStock ?? 0,
    cartDraft: item.cartDraft ?? null,
    productsHistory: item.productsHistory || [],
    updatedAt: item.updatedAt || new Date().toISOString(),
  });
  await setDoc(itemRef, payload, { merge: true });
}

export async function deleteItemFromFirestore(itemId: string, listId?: string): Promise<void> {
  if (!listId) return;
  const itemRef = doc(db, 'acquisition_lists', listId, 'items', itemId);
  await deleteDoc(itemRef);
}

// ============================================================================
// 6. CATEGORIAS E SUBCATEGORIAS (`taxonomy`)
// ============================================================================

export async function saveTaxonomyGroupToFirestore(group: TaxonomyGroup): Promise<void> {
  try {
    const groupRef = doc(db, 'taxonomy', group.id);
    await setDoc(groupRef, group, { merge: true });
  } catch (err) {
    console.warn('[Firestore / Offline fallback] saveTaxonomyGroupToFirestore:', err);
  }
}

export async function deleteTaxonomyGroupFromFirestore(groupId: string): Promise<void> {
  try {
    const groupRef = doc(db, 'taxonomy', groupId);
    await deleteDoc(groupRef);
  } catch (err) {
    console.warn('[Firestore / Offline fallback] deleteTaxonomyGroupFromFirestore:', err);
  }
}

// ============================================================================
// 7. ARMAZENAMENTO (FIREBASE STORAGE - RECIBOS, FOTOS E AVATARES)
// ============================================================================

export async function uploadFileToFirebaseStorage(
  file: File,
  folder: 'receipts' | 'products' | 'avatars',
  ownerId: string
): Promise<string> {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const effectiveUid = auth.currentUser?.uid || ownerId;
  const storagePath = `users/${effectiveUid}/${folder}/${Date.now()}_${safeName}`;
  try {
    const storageRef = ref(storage, storagePath);
    const snapshot = await uploadBytes(storageRef, file);
    const downloadUrl = await getDownloadURL(snapshot.ref);
    return downloadUrl;
  } catch (err) {
    console.warn(
      '[Firebase Storage] Usando DataURL local para visualização imediata:',
      err
    );
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(file);
    });
  }
}
