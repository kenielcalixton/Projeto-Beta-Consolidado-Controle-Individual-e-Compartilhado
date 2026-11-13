import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecurrenceRule,
  generateRecurrenceInstance,
  updateRecurrenceRuleStatus,
  getRecurrenceRules,
  getRecurrenceRuleById,
  getRecurrenceInstances,
  createInstallmentContract,
  cancelInstallmentContract,
  getInstallmentContracts,
  getInstallmentContractById,
  getInstallmentOccurrences,
} from './recurrenceService';
import { universalStorage } from '../utils/universalStorage';
import { InstallmentOccurrence } from '../types/financeV3';
import { loadDemoInvoices } from './creditCardService';

describe('RecurrenceService (Fase 9 - Recorrências e Parcelamentos Desacoplados)', () => {
  beforeEach(() => {
    universalStorage.clear();
  });

  describe('Recurrence Rules & Instances', () => {
    it('cria regra de recorrência com sucesso em modo demo', async () => {
      const res = await createRecurrenceRule(
        {
          scope: 'personal',
          userId: 'user_rec_1',
          title: 'Assinatura Streaming',
          amountCents: 3990,
          frequency: 'monthly',
          startCompetence: '2026-01',
          dueDay: 15,
          idempotencyKey: 'idem_rec_rule_01',
        },
        true
      );

      assert.equal(res.isIdempotentReplay, false);
      assert.ok(res.rule.id.includes('rec_idem_rec_rule_01'));
      assert.equal(res.rule.title, 'Assinatura Streaming');
      assert.equal(res.rule.amountCents, 3990);
      assert.equal(res.rule.dueDay, 15);
      assert.equal(res.rule.status, 'active');
    });

    it('reproduz idempotência ao tentar recriar a mesma regra de recorrência', async () => {
      const res1 = await createRecurrenceRule(
        {
          scope: 'personal',
          userId: 'user_rec_1',
          title: 'Internet Fibra',
          amountCents: 12000,
          startCompetence: '2026-01',
          dueDay: 10,
          idempotencyKey: 'idem_rec_rule_dup',
        },
        true
      );
      assert.equal(res1.isIdempotentReplay, false);

      const res2 = await createRecurrenceRule(
        {
          scope: 'personal',
          userId: 'user_rec_1',
          title: 'Internet Fibra',
          amountCents: 12000,
          startCompetence: '2026-01',
          dueDay: 10,
          idempotencyKey: 'idem_rec_rule_dup',
        },
        true
      );
      assert.equal(res2.isIdempotentReplay, true);
      assert.equal(res2.rule.id, res1.rule.id);
    });

    it('gera instâncias de recorrência por competência com idempotência', async () => {
      const { rule } = await createRecurrenceRule(
        {
          scope: 'personal',
          userId: 'user_rec_2',
          title: 'Plano Academia',
          amountCents: 9900,
          startCompetence: '2026-01',
          dueDay: 5,
          idempotencyKey: 'idem_rec_rule_gym',
        },
        true
      );

      const gen1 = await generateRecurrenceInstance(
        {
          ruleId: rule.id,
          competenceMonth: '2026-01',
        },
        true
      );
      assert.equal(gen1.isIdempotentReplay, false);
      assert.equal(gen1.instance.competenceMonth, '2026-01');
      assert.equal(gen1.instance.actualAmountCents, 9900);
      assert.equal(gen1.instance.generationStatus, 'generated');

      // Idempotência para a mesma competência
      const gen2 = await generateRecurrenceInstance(
        {
          ruleId: rule.id,
          competenceMonth: '2026-01',
        },
        true
      );
      assert.equal(gen2.isIdempotentReplay, true);
      assert.equal(gen2.instance.id, gen1.instance.id);

      // Nova competência
      const genFeb = await generateRecurrenceInstance(
        {
          ruleId: rule.id,
          competenceMonth: '2026-02',
        },
        true
      );
      assert.equal(genFeb.isIdempotentReplay, false);
      assert.equal(genFeb.instance.competenceMonth, '2026-02');

      const allInstances = await getRecurrenceInstances(rule.id, true);
      assert.equal(allInstances.length, 2);
    });

    it('impede geração de instâncias para regra de recorrência cancelada', async () => {
      const { rule } = await createRecurrenceRule(
        {
          scope: 'personal',
          userId: 'user_rec_3',
          title: 'Serviço Cancelado',
          amountCents: 5000,
          startCompetence: '2026-01',
          dueDay: 20,
          idempotencyKey: 'idem_rec_rule_cancel',
        },
        true
      );

      await updateRecurrenceRuleStatus({ ruleId: rule.id, status: 'cancelled' }, true);

      await assert.rejects(
        async () => {
          await generateRecurrenceInstance(
            {
              ruleId: rule.id,
              competenceMonth: '2026-03',
            },
            true
          );
        },
        {
          message: 'Regra de recorrência está cancelada.',
        }
      );
    });
  });

  describe('Installment Contracts & Strict Cent-Conservation', () => {
    it('divide o valor total do contrato em parcelas preservando estritamente os centavos (resto na 1ª parcela)', async () => {
      // R$ 100,00 (10.000 centavos) divididos em 3 parcelas
      // 10000 / 3 = 3333 centavos. Resto = 1 centavo.
      // Parcela 1: 3334 centavos
      // Parcela 2: 3333 centavos
      // Parcela 3: 3333 centavos
      const res = await createInstallmentContract(
        {
          scope: 'personal',
          userId: 'user_inst_1',
          title: 'Smartphone Novo',
          totalContractAmountCents: 10000,
          totalInstallmentsCount: 3,
          startCompetenceMonth: '2026-03',
          dueDay: 10,
          idempotencyKey: 'idem_inst_contract_01',
        },
        true
      );

      assert.equal(res.isIdempotentReplay, false);
      assert.ok(res.contract.id.startsWith('inst_idem_inst_contract'));
      assert.equal(res.contract.totalContractAmountCents, 10000);
      assert.equal(res.contract.status, 'active');

      const occurrences = await getInstallmentOccurrences(res.contract.id, true);
      assert.equal(occurrences.length, 3);

      assert.equal(occurrences[0].installmentNumber, 1);
      assert.equal(occurrences[0].competenceMonth, '2026-03');
      assert.equal(occurrences[0].dueDate, '2026-03-10');
      assert.equal(occurrences[0].principalAmountCents, 3334);
      assert.equal(occurrences[0].totalInstallmentAmountCents, 3334);
      assert.equal(occurrences[0].status, 'scheduled');

      assert.equal(occurrences[1].installmentNumber, 2);
      assert.equal(occurrences[1].competenceMonth, '2026-04');
      assert.equal(occurrences[1].dueDate, '2026-04-10');
      assert.equal(occurrences[1].principalAmountCents, 3333);
      assert.equal(occurrences[1].totalInstallmentAmountCents, 3333);
      assert.equal(occurrences[1].status, 'scheduled');

      assert.equal(occurrences[2].installmentNumber, 3);
      assert.equal(occurrences[2].competenceMonth, '2026-05');
      assert.equal(occurrences[2].dueDate, '2026-05-10');
      assert.equal(occurrences[2].principalAmountCents, 3333);
      assert.equal(occurrences[2].totalInstallmentAmountCents, 3333);
      assert.equal(occurrences[2].status, 'scheduled');

      // Conservação contábil exata da soma dos centavos
      const sumCents = occurrences.reduce((acc, o) => acc + o.principalAmountCents, 0);
      assert.equal(sumCents, 10000);
    });

    it('cancela antecipadamente o contrato de parcelamento preservando parcelas já faturadas ou pagas', async () => {
      const res = await createInstallmentContract(
        {
          scope: 'personal',
          userId: 'user_inst_2',
          title: 'Notebook Trabalho',
          totalContractAmountCents: 300000,
          totalInstallmentsCount: 3,
          startCompetenceMonth: '2026-01',
          dueDay: 15,
          idempotencyKey: 'idem_inst_contract_cancel',
        },
        true
      );

      // Simula que a parcela 1 foi paga e a parcela 2 foi faturada (billed)
      const raw = universalStorage.getItem('demo_installment_occurrences_v3');
      const occs: InstallmentOccurrence[] = raw ? JSON.parse(raw) : [];
      const idx1 = occs.findIndex((o) => o.contractId === res.contract.id && o.installmentNumber === 1);
      const idx2 = occs.findIndex((o) => o.contractId === res.contract.id && o.installmentNumber === 2);
      occs[idx1].status = 'paid';
      occs[idx2].status = 'billed';
      universalStorage.setItem('demo_installment_occurrences_v3', JSON.stringify(occs));

      // Executa o cancelamento antecipado
      const cancelRes = await cancelInstallmentContract(
        {
          contractId: res.contract.id,
          cancellationReason: 'Devolução parcial negociada com lojista',
        },
        true
      );

      assert.equal(cancelRes.contract.status, 'cancelled_early');
      assert.equal(cancelRes.contract.cancellationReason, 'Devolução parcial negociada com lojista');
      assert.equal(cancelRes.cancelledCount, 1); // Apenas a parcela 3 (scheduled) foi cancelada

      const occurrencesAfter = await getInstallmentOccurrences(res.contract.id, true);
      assert.equal(occurrencesAfter[0].status, 'paid'); // Intacta
      assert.equal(occurrencesAfter[1].status, 'billed'); // Intacta
      assert.equal(occurrencesAfter[2].status, 'cancelled'); // Cancelada
    });

    it('projeta parcelas em faturas futuras quando fundingSource é credit_card e estorna montante ao cancelar', async () => {
      const cardAccountId = 'card_visa_platinum_999';
      const res = await createInstallmentContract(
        {
          scope: 'personal',
          userId: 'user_card_holder',
          title: 'Geladeira Inox Parcelada',
          totalContractAmountCents: 120000,
          totalInstallmentsCount: 3,
          startCompetenceMonth: '2026-06',
          dueDay: 10,
          fundingSource: 'credit_card',
          sourceCardAccountId: cardAccountId,
          idempotencyKey: 'idem_inst_card_proj',
        },
        true
      );

      assert.equal(res.contract.fundingSource, 'credit_card');
      assert.equal(res.contract.sourceCardAccountId, cardAccountId);

      // Inspeciona faturas projetadas no armazenamento demo
      const invoices = loadDemoInvoices();
      assert.equal(invoices.length, 3);

      const invJune = invoices.find((i: any) => i.invoiceMonth === '2026-06');
      const invJuly = invoices.find((i: any) => i.invoiceMonth === '2026-07');
      const invAug = invoices.find((i: any) => i.invoiceMonth === '2026-08');

      assert.ok(invJune);
      assert.equal(invJune.totalPurchasesAmountCents, 40000);
      assert.ok(invJuly);
      assert.equal(invJuly.totalPurchasesAmountCents, 40000);
      assert.ok(invAug);
      assert.equal(invAug.totalPurchasesAmountCents, 40000);

      // Cancela o contrato antes de qualquer faturamento
      const cancelRes = await cancelInstallmentContract(
        {
          contractId: res.contract.id,
          cancellationReason: 'Compra estornada na operadora',
        },
        true
      );
      assert.equal(cancelRes.cancelledCount, 3);

      // Verifica que o montante foi liberado das faturas futuras
      const invoicesAfter = loadDemoInvoices();

      const invJuneAfter = invoicesAfter.find((i: any) => i.invoiceMonth === '2026-06');
      const invJulyAfter = invoicesAfter.find((i: any) => i.invoiceMonth === '2026-07');
      const invAugAfter = invoicesAfter.find((i: any) => i.invoiceMonth === '2026-08');

      assert.ok(invJuneAfter);
      assert.equal(invJuneAfter.totalPurchasesAmountCents, 0);
      assert.ok(invJulyAfter);
      assert.equal(invJulyAfter.totalPurchasesAmountCents, 0);
      assert.ok(invAugAfter);
      assert.equal(invAugAfter.totalPurchasesAmountCents, 0);
    });

    it('gera PersonalTransaction ao gerar instância de recorrência pessoal em modo demo', async () => {
      const { rule } = await createRecurrenceRule(
        {
          scope: 'personal',
          userId: 'user_rec_tx',
          title: 'Internet Condomínio',
          amountCents: 14990,
          startCompetence: '2026-11',
          dueDay: 12,
          defaultAccountId: 'acc_checking_1',
          idempotencyKey: 'idem_rec_tx_gen',
        },
        true
      );

      const res = await generateRecurrenceInstance(
        { ruleId: rule.id, competenceMonth: '2026-11' },
        true
      );

      assert.ok(res.instance.generatedTransactionId);
      const rawTxs = universalStorage.getItem('mpf_v3_demo_personal_transactions');
      const txs = rawTxs ? (JSON.parse(rawTxs) as any[]) : [];
      const createdTx = txs.find((t) => t.id === res.instance.generatedTransactionId);
      assert.ok(createdTx);
      assert.equal(createdTx.userId, 'user_rec_tx');
      assert.equal(createdTx.amountCents, 14990);
      assert.equal(createdTx.dueDate, '2026-11-12');
      assert.equal(createdTx.accountId, 'acc_checking_1');
      assert.equal(createdTx.originType, 'recurrence');
      assert.equal(createdTx.status, 'pending');
    });

    it('projeta apenas parcelas vigentes/futuras (5..10) em contrato em andamento sem fabricar histórico 1..4', async () => {
      const cardAccountId = 'card_ongoing_5_10';
      const res = await createInstallmentContract(
        {
          scope: 'personal',
          userId: 'user_ongoing',
          title: 'TV OLED 10x',
          totalContractAmountCents: 100000,
          remainingAmountCents: 60000,
          totalInstallmentsCount: 10,
          initialInstallmentNumber: 5,
          startCompetenceMonth: '2026-11',
          dueDay: 15,
          fundingSource: 'credit_card',
          sourceCardAccountId: cardAccountId,
          idempotencyKey: 'idem_ongoing_5_10',
        },
        true
      );

      assert.equal(res.contract.initialInstallmentNumber, 5);
      assert.equal(res.contract.remainingAmountCents, 60000);

      const occurrences = await getInstallmentOccurrences(res.contract.id, true);
      assert.equal(occurrences.length, 6);
      assert.deepEqual(
        occurrences.map((o) => o.installmentNumber),
        [5, 6, 7, 8, 9, 10]
      );
      assert.deepEqual(
        occurrences.map((o) => o.competenceMonth),
        ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04']
      );
      assert.equal(
        occurrences.reduce((sum, o) => sum + o.principalAmountCents, 0),
        60000
      );

      const invoices = loadDemoInvoices().filter((i: any) => i.accountId === cardAccountId);
      assert.equal(invoices.length, 6);
      assert.equal(
        invoices.reduce((sum: number, inv: any) => sum + inv.totalPurchasesAmountCents, 0),
        60000
      );
    });
  });

  describe('Explicit Scope Requirement & Deduplication (Extrato Root Cause Regression)', () => {
    it('rejeita getRecurrenceRules sem scope explícito e exige userId/spaceId coerentes', async () => {
      await assert.rejects(
        () => getRecurrenceRules({ userId: 'u_1' } as any, true),
        (err: any) => String(err?.message || err).includes('scope')
      );
      await assert.rejects(
        () => getRecurrenceRules({ scope: 'personal' } as any, true),
        (err: any) => String(err?.message || err).includes('userId')
      );
      await assert.rejects(
        () => getRecurrenceRules({ scope: 'shared' } as any, true),
        (err: any) => String(err?.message || err).includes('spaceId')
      );
    });

    it('rejeita getInstallmentContracts sem scope explícito e exige userId/spaceId coerentes', async () => {
      await assert.rejects(
        () => getInstallmentContracts({ userId: 'u_1' } as any, true),
        (err: any) => String(err?.message || err).includes('scope')
      );
      await assert.rejects(
        () => getInstallmentContracts({ scope: 'personal' } as any, true),
        (err: any) => String(err?.message || err).includes('userId')
      );
      await assert.rejects(
        () => getInstallmentContracts({ scope: 'shared' } as any, true),
        (err: any) => String(err?.message || err).includes('spaceId')
      );
    });

    it('isola escopo personal vs shared e desduplica regras e contratos por ID', async () => {
      const pRule = await createRecurrenceRule(
        {
          scope: 'personal',
          userId: 'user_scope_a',
          title: 'Aluguel Individual',
          amountCents: 200000,
          startCompetence: '2026-11',
          dueDay: 5,
          idempotencyKey: 'idem_scope_p1',
        },
        true
      );
      const sRule = await createRecurrenceRule(
        {
          scope: 'shared',
          userId: 'user_scope_a',
          spaceId: 'space_scope_1',
          title: 'Condomínio Espaço',
          amountCents: 80000,
          startCompetence: '2026-11',
          dueDay: 10,
          idempotencyKey: 'idem_scope_s1',
        },
        true
      );

      // Injeta duplicata artificial no demo storage para garantir desduplicação
      const rawRules = JSON.parse(universalStorage.getItem('demo_recurrence_rules_v3') || '[]');
      rawRules.push({ ...pRule.rule });
      universalStorage.setItem('demo_recurrence_rules_v3', JSON.stringify(rawRules));

      const personalRules = await getRecurrenceRules({ scope: 'personal', userId: 'user_scope_a' }, true);
      assert.equal(personalRules.length, 1);
      assert.equal(personalRules[0].id, pRule.rule.id);

      const sharedRules = await getRecurrenceRules({ scope: 'shared', spaceId: 'space_scope_1' }, true);
      assert.equal(sharedRules.length, 1);
      assert.equal(sharedRules[0].id, sRule.rule.id);

      const pContract = await createInstallmentContract(
        {
          scope: 'personal',
          userId: 'user_scope_a',
          title: 'Monitor 3x',
          totalContractAmountCents: 90000,
          totalInstallmentsCount: 3,
          startCompetenceMonth: '2026-11',
          dueDay: 12,
          idempotencyKey: 'idem_scope_c1',
        },
        true
      );

      const rawContracts = JSON.parse(universalStorage.getItem('demo_installment_contracts_v3') || '[]');
      rawContracts.push({ ...pContract.contract });
      universalStorage.setItem('demo_installment_contracts_v3', JSON.stringify(rawContracts));

      const personalContracts = await getInstallmentContracts({ scope: 'personal', userId: 'user_scope_a' }, true);
      assert.equal(personalContracts.length, 1);
      assert.equal(personalContracts[0].id, pContract.contract.id);
    });
  });
});

