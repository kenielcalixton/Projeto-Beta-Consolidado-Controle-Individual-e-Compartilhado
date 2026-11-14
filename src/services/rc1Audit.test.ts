import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURATED_COLOR_PALETTE,
  SPACE_ICON_OPTIONS,
  VISUAL_ICON_OPTIONS,
  resolveColorTokenFromValue,
  resolveHexColor,
  resolvePhosphorCategoryIcon,
} from '../utils/visualPickerUtils';
import {
  evaluateInviteAvailability,
  extractInviteToken,
} from './spaceInviteService';
import { stripUndefinedDeep } from './acquisitionsFirebase';
import {
  confirmCartCheckout,
  returnConfirmedToStock,
  revertConfirmedCheckout,
} from '../utils/stateMachine';
import { AcquisitionItem } from '../types/acquisitions';
import { SpaceInvite } from '../types/financeV3';

describe('RC1 AUDIT — Testes Unitários de Pickers, Convites, Sanitização e Carrinho de Aquisições', () => {
  it('1. visualPickerUtils resolve ícones Phosphor, nomes legados e paletas de cores corretamente', () => {
    assert.ok(VISUAL_ICON_OPTIONS.length >= 20);
    assert.ok(SPACE_ICON_OPTIONS.length >= 6);
    assert.ok(CURATED_COLOR_PALETTE.length >= 10);

    assert.equal(resolvePhosphorCategoryIcon('ph-wallet'), 'ph-wallet');
    assert.equal(resolvePhosphorCategoryIcon('utensils'), 'ph-fork-knife');
    assert.equal(resolvePhosphorCategoryIcon('home'), 'ph-house-line');
    assert.equal(resolvePhosphorCategoryIcon('trending-up'), 'ph-trend-up');
    assert.equal(resolvePhosphorCategoryIcon(''), 'ph-tag');
    assert.equal(resolvePhosphorCategoryIcon(null), 'ph-tag');

    assert.equal(resolveHexColor('emerald'), '#10B981');
    assert.equal(resolveHexColor('indigo'), '#4F46E5');
    assert.equal(resolveHexColor('#abc'), '#AABBCC');
    assert.equal(resolveHexColor('#1234ef'), '#1234EF');
    assert.equal(resolveHexColor(undefined, '#4F46E5'), '#4F46E5');

    assert.equal(resolveColorTokenFromValue('#10b981'), 'emerald');
    assert.equal(resolveColorTokenFromValue('rose'), 'rose');
    assert.equal(resolveColorTokenFromValue('#ABCDEF'), '#ABCDEF');
  });

  it('2. extractInviteToken e evaluateInviteAvailability validam todos os estados de token', () => {
    assert.equal(
      extractInviteToken('https://meufinanceiro.app/spaces?token=tok_abc_123&ref=copy'),
      'tok_abc_123'
    );
    assert.equal(
      extractInviteToken('?invite=tok_encoded%2B456#section'),
      'tok_encoded+456'
    );
    assert.equal(extractInviteToken('  "tok_raw_789"  '), 'tok_raw_789');
    assert.equal(extractInviteToken('   '), '');

    const baseInvite: SpaceInvite = {
      id: 'hash_1',
      spaceId: 'space_1',
      spaceName: 'Casa Compartilhada',
      invitedEmail: 'bob@example.com',
      invitedRole: 'member',
      invitedByUid: 'uid_alice',
      invitedByName: 'Alice',
      tokenStatus: 'pending',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: new Date().toISOString(),
    };

    const notFound = evaluateInviteAvailability(null);
    assert.equal(notFound.canAccept, false);
    assert.equal(notFound.code, 'not_found');

    const accepted = evaluateInviteAvailability(
      { ...baseInvite, tokenStatus: 'accepted', acceptedByUid: 'uid_bob' },
      { currentUserUid: 'uid_bob' }
    );
    assert.equal(accepted.canAccept, false);
    assert.equal(accepted.code, 'accepted');

    const revoked = evaluateInviteAvailability({ ...baseInvite, tokenStatus: 'revoked' });
    assert.equal(revoked.canAccept, false);
    assert.equal(revoked.code, 'revoked');

    const rejected = evaluateInviteAvailability({ ...baseInvite, tokenStatus: 'rejected' });
    assert.equal(rejected.canAccept, false);
    assert.equal(rejected.code, 'rejected');

    const expired = evaluateInviteAvailability({
      ...baseInvite,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.equal(expired.canAccept, false);
    assert.equal(expired.code, 'expired');

    const alreadyMember = evaluateInviteAvailability(baseInvite, {
      currentUserUid: 'uid_bob',
      currentUserEmail: 'bob@example.com',
      activeMemberUids: ['uid_alice', 'uid_bob'],
    });
    assert.equal(alreadyMember.canAccept, false);
    assert.equal(alreadyMember.code, 'already_member');

    const emailMismatch = evaluateInviteAvailability(baseInvite, {
      currentUserUid: 'uid_carol',
      currentUserEmail: 'carol@example.com',
      activeMemberUids: ['uid_alice'],
    });
    assert.equal(emailMismatch.canAccept, false);
    assert.equal(emailMismatch.code, 'email_mismatch');

    const valid = evaluateInviteAvailability(baseInvite, {
      currentUserUid: 'uid_bob',
      currentUserEmail: 'BOB@example.com',
      activeMemberUids: ['uid_alice'],
    });
    assert.equal(valid.canAccept, true);
    assert.equal(valid.code, 'valid');
  });

  it('3. stripUndefinedDeep remove undefined recursivamente sem apagar null, 0 ou false', () => {
    const input = {
      id: 'item_1',
      count: 0,
      archived: false,
      cartDraft: null,
      notes: undefined,
      nested: {
        brand: 'Marca X',
        receiptUrl: undefined,
        qty: 0,
      },
      items: [undefined, { a: 1, b: undefined }, 'ok'],
    };

    const cleaned = stripUndefinedDeep(input) as Record<string, unknown>;
    assert.equal('notes' in cleaned, false);
    assert.equal(cleaned.count, 0);
    assert.equal(cleaned.archived, false);
    assert.equal(cleaned.cartDraft, null);
    assert.deepEqual(cleaned.nested, { brand: 'Marca X', qty: 0 });
    assert.deepEqual(cleaned.items, [{ a: 1 }, 'ok']);
  });

  it('4. Máquina de estados de Aquisições preserva estoque, cartDraft e histórico em Carrinho -> Conferido -> Estorno -> Estoque', () => {
    const baseItem: AcquisitionItem = {
      id: 'item_arroz',
      listId: 'list_despensa',
      workspaceId: 'ws_1',
      createdByUid: 'uid_alice',
      name: 'Arroz Tipo 1',
      groupId: 'grp_alim',
      categoryId: 'cat_graos',
      listType: 'recorrente',
      stage: 'carrinho',
      acceptedMemberEmails: ['alice@local'],
      currentStock: 1,
      minStock: 2,
      unit: 'pct',
      productsHistory: [],
      updatedAt: '2026-11-01T10:00:00.000Z',
    };

    const { updatedItem: confirmed, newProduct } = confirmCartCheckout(baseItem, {
      brand: 'Tio João',
      unitPrice: 28.5,
      quantity: 3,
      storeName: 'Supermercado Central',
    });

    assert.equal(confirmed.stage, 'conferido');
    assert.equal(confirmed.currentStock, 4);
    assert.equal(confirmed.productsHistory.length, 1);
    assert.equal(newProduct.totalPrice, 85.5);
    assert.equal(confirmed.cartDraft?.brand, 'Tio João');
    assert.equal(confirmed.cartDraft?.quantity, 3);

    const reverted = revertConfirmedCheckout(confirmed);
    assert.equal(reverted.stage, 'carrinho');
    assert.equal(reverted.currentStock, 1);

    const closedToStock = returnConfirmedToStock(confirmed);
    assert.equal(closedToStock.stage, 'estoque');
    assert.equal(closedToStock.currentStock, 4);
    assert.equal(closedToStock.cartDraft, undefined);
    assert.equal(closedToStock.productsHistory.length, 1);
  });
});
