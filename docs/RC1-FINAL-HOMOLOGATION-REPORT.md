# Relatório Final Consolidado de Homologação — Projeto Beta v3.1 (RC1)

## 1. Identificação do Projeto, Branch e Commit

- **Projeto:** Projeto Beta — Controle Financeiro Individual e Compartilhado v3.1 (RC1)
- **Repositório:** `kenielcalixton/Projeto-Beta-Consolidado-Controle-Individual-e-Compartilhado`
- **Branch homologada:** `homologation/rc1-e2e`
- **Commit-base (`HEAD`):** `04761b83a26f5b954ed5b51b05491106c7975b44` (`04761b8` — `fix(firebase): corrigir dependencias do emulator e functions`)
- **Commit anterior da homologação/auditoria RC1:** `55e38294ba70d2cbb3c2dff89819ab393f5fdd33` (`55e3829` — `release(rc1): consolidar homologacao e auditoria de seguranca v3.1`)
- **Branch `main` (preservada e inalterada):** `b08b9bda84195b90a831e0ffa7f5debf82a1a465` (`b08b9bd`)
- **Estado do working tree:** alterações locais da correção de Storage e da correção de integridade contábil/estorno de aquisições aplicadas e validadas em `homologation/rc1-e2e`, **ainda não commitadas** (`functions/index.js`, `src/services/acquisitionsService.ts`, `src/services/acquisitionsService.test.ts`, `src/services/phase8.emulator.test.ts`, `storage.rules`, `src/services/storage.rules.test.ts`, além deste relatório)
- **Projeto Firebase local configurado em `.firebaserc`:** `demo-projeto-beta-v3` (exclusivo para emuladores locais)
- **Data da consolidação:** 2026-11-15

---

## 2. Objetivo da Homologação

Consolidar a validação técnica completa da versão **v3.1 (RC1)** na branch `homologation/rc1-e2e` após a resolução das pendências de Storage e de integridade contábil/atomicidade em aquisições, abrangendo:

1. Verificação estática de tipagem (`typecheck`) e empacotamento de produção (`build`).
2. Execução das suítes unitárias e de integração em memória (`npm test`).
3. Validação real das regras de segurança Firestore (`firestore.rules`) e Storage (`storage.rules`) no Firebase Emulator Suite.
4. Validação ponta a ponta de cenários multiusuário e das **50 Cloud Functions** no Firebase Emulator Suite após as correções de compatibilidade (`04761b8`), endurecimento de `storage.rules` e integridade contábil/estorno da Fase 8.
5. Registro formal das evidências, problemas corrigidos, ressalvas de ambiente, limitações funcionais explícitas, pendências pré-produção e conclusão técnica.

---

## 3. Ambiente Utilizado e Versões das Ferramentas

Todas as execuções ocorreram exclusivamente em ambiente local (sem acesso, escrita ou deploy em projetos Firebase remotos):

| Componente / Ferramenta | Versão / Configuração Verificada |
| :--- | :--- |
| **Sistema Operacional** | Linux (Debian 12, VM com 8 GB de RAM total e 0 swap) |
| **Node.js (host)** | `v24.22.2` |
| **npm** | `11.21.2` |
| **Java (runtime dos emuladores)** | `openjdk version "17.0.21"` (`OpenJDK 64-Bit Server VM`) |
| **Firebase CLI (`firebase-tools`, raiz)** | `14.27.0` (`^14.27.0` em `package.json`) |
| **Firebase JS SDK (cliente)** | `^13.2.0` (`package.json`) |
| **`firebase-functions` (raiz e `functions/`)** | `7.4.0` (`^7.4.0`) |
| **`firebase-admin` (raiz)** | `14.5.0` (`^14.5.0`) |
| **`firebase-admin` (`functions/`)** | `14.5.1` (`^14.5.0` em `functions/package.json`) |
| **Engine declarada em `functions/package.json` e `firebase.json`** | `nodejs22` (`"node": "22"`) |
| **Emuladores locais (`127.0.0.1`)** | Auth (`9099`), Firestore (`8080`), Functions (`5001`), Storage (`9199`), UI (`4000`) |

---

## 4. Resultado dos Testes Gerais

Executados na branch `homologation/rc1-e2e` sobre a árvore de trabalho final (após as correções de `storage.rules`, de integridade contábil/estorno de aquisições e da validação prévia/sequenciamento do estorno em modo Demo):

| Verificação | Comando | Resultado | Detalhes Documentados |
| :--- | :--- | :--- | :--- |
| **Typecheck** | `npm run typecheck` (`tsc --noEmit`) | **Aprovado** | Saída `0`, zero erros de tipagem TypeScript em todo o projeto e suítes de teste. |
| **Build** | `npm run build` (`vite build`) | **Aprovado** | Saída `0`, `dist/` gerado (`vite v8.3.7`, `1742` módulos transformados, concluído em `1.01 s`). |
| **Testes Gerais** | `npm test` (`tsx --test ...`) | **Aprovado (184/184)** | **184** testes aprovados em **14** suítes (`0` falhas, `0` ignorados, duração `5994 ms`), incluindo **17/17** em `src/services/acquisitionsService.test.ts` (novos testes `11` a `17` do modo Demo). |

---

## 5. Resultado dos Testes de Regras

| Verificação | Comando / Arquivo | Resultado | Base da Execução / Detalhes Documentados |
| :--- | :--- | :---: | :--- |
| **Firestore Security Rules** | `npm run test:rules` (`src/services/firestore.rules.test.ts`) | **Aprovado (16/16)** | **16 / 16** itens aprovados (`1` bloco pai + `15` subtestes) na base `04761b8` e **reexecutados com 100% de aprovação dentro do Lote 1A** pós-correções (`firestore.rules` inalterada desde `04761b8`). |
| **Storage Security Rules** | `npx firebase emulators:exec --only storage --project demo-projeto-beta-v3 "tsx --test src/services/storage.rules.test.ts"` | **Aprovado (5/5)** | **5 / 5** itens aprovados (`1` bloco pai + `4` subtestes) após correção de `storage.rules` (que permaneceu inalterada nas etapas posteriores): acesso legítimo em `users/{uid}/...`, bloqueio cross-user, bloqueio anônimo e negação explícita (`allow read, write: if false;`) em `/spaces/{spaceId}/{allPaths=**}`. |

Cobertura validada nas regras (`firestore.rules` e `storage.rules`):
- Bloqueio de usuários não autenticados e usuários externos ao espaço (`StrangerEve`, `uid_eve`).
- Separação de governança entre membro, administrador e criador original, além de congelamento em espaços arquivados.
- Restrição histórica para ex-participante/removido e anti-spoofing de auditoria e notificações críticas.
- Proteção client-side de saldos projetados e coleções autoritativas (`movements`, `liabilities`, `payments`, `purchases`, `purchase_reversals`, `stock_movements`, `quotes`, `deposits`, `instances`, `installment_contracts`, `occurrences`).
- Reabertura de dissolução restrita exclusivamente ao criador após cancelamento (Teste #12) e endurecimentos adicionados na auditoria (Testes #13, #14 e #15).
- No Storage, isolamento estrito em `users/{userId}/{allPaths=**}` (`request.auth != null && request.auth.uid == userId`) e negação explícita (`allow read, write: if false;`) em `/spaces/{spaceId}/{allPaths=**}`.

*(Complementarmente, durante a homologação E2E registrada em `docs/reports/RC1-E2E-HOMOLOGATION-REPORT.md`, 11 sondas HTTP REST diretas contra o Firestore Emulator retornaram `HTTP 403` para acessos/escritas ilegítimas.)*

---

## 6. Resultado dos Cenários de Integração

| Verificação | Comando | Resultado | Base da Execução / Detalhes Documentados |
| :--- | :--- | :---: | :--- |
| **Cenário Completo de Dois Usuários (Alice & Bob)** | `npm run test:scenario` (`src/services/twoUsersScenario.emulator.test.ts`) | **Aprovado (8/8)** | **8 / 8** itens aprovados (`1` bloco pai + `7` subtestes, duração `23599 ms`) na rodada base do commit `04761b8` com Auth, Firestore, Storage e Functions Emulators (cobre login, isolamento individual, despesa compartilhada, custódia e restituição; não exerce aquisições nem Storage `/spaces/`). |

Fluxos validados no cenário integrado:
- Registro/login independentes no Auth Emulator e isolamento individual entre Alice e Bob.
- Criação de espaço, emissão de convite e aceite via Cloud Functions oficiais.
- Despesa compartilhada (50/50), declaração de pagamento de cota pelo devedor e validação exclusiva pelo responsável financeiro.
- Fluxo de custódia em 2 etapas (transferência, confirmação de recebimento, declaração de devolução e confirmação da devolução).
- Confirmação de restituição e estorno compensatório.
- Bloqueios de governança (tentativa ilegítima de aprovação e manipulação direta de movimentações).

**Carregamento das Cloud Functions verificado no Emulator (reconfirmado nos Lotes 1A, 1B e 2 pós-correções):**
- Todas as **50 Cloud Functions** definidas em `functions/index.js` foram carregadas e inicializadas (`Loaded functions definitions from source`).
- **Nenhum erro de `functions.config()`**.
- **Nenhum aviso ou erro de dependência ausente de `firebase-admin`**.

*(Registro histórico complementar: na etapa E2E anterior em Chromium real via Playwright, documentada em `docs/reports/RC1-E2E-HOMOLOGATION-REPORT.md`, as 4 suítes `e2e-suite1.mjs` a `e2e-suite4.mjs` foram aprovadas com `pageErrors = 0`, `consoleWarnings = 0` e sem overflow horizontal em desktop `1440×900`, tablet `768×1024` e mobile `390×844`.)*

---

## 7. Resultado dos Três Lotes do Firebase Emulator

A execução integral da suíte `test:emulator` sobre o estado final do working tree (após todas as alterações de Storage e aquisições) foi realizada sequencialmente em **3 lotes isolados**, encerrando os emuladores ao término de cada lote:

| Lote | Arquivos Executados | Comando Utilizado | Aprovados | Reprovados | Duração da Suíte |
| :--- | :--- | :--- | :---: | :---: | :---: |
| **Lote 1A** | `src/services/firestore.rules.test.ts`<br>`src/services/phase34.emulator.test.ts`<br>`src/services/phase5.emulator.test.ts`<br>`src/services/phase6.emulator.test.ts` | `npx firebase emulators:exec --only auth,firestore,storage,functions --project demo-projeto-beta-v3 "npx tsx --test --test-concurrency=1 --test-force-exit src/services/firestore.rules.test.ts src/services/phase34.emulator.test.ts src/services/phase5.emulator.test.ts src/services/phase6.emulator.test.ts"` | **43** | **0** | `61749 ms` |
| **Lote 1B** | `src/services/phase7.emulator.test.ts`<br>`src/services/phase8.emulator.test.ts`<br>`src/services/phase9.emulator.test.ts` | `npx firebase emulators:exec --only auth,firestore,storage,functions --project demo-projeto-beta-v3 "npx tsx --test --test-concurrency=1 --test-force-exit src/services/phase7.emulator.test.ts src/services/phase8.emulator.test.ts src/services/phase9.emulator.test.ts"` | **31** | **0** | `38305 ms` |
| **Lote 2** | `src/services/extratoUniversalForm.emulator.test.ts`<br>`src/services/spaceCreationFlow.emulator.test.ts`<br>`src/services/rc1Audit.emulator.test.ts`<br>`src/services/invitesAndLedgers.emulator.test.ts` | `npx firebase emulators:exec --only auth,firestore,storage,functions --project demo-projeto-beta-v3 "npx tsx --test --test-concurrency=1 --test-force-exit src/services/extratoUniversalForm.emulator.test.ts src/services/spaceCreationFlow.emulator.test.ts src/services/rc1Audit.emulator.test.ts src/services/invitesAndLedgers.emulator.test.ts"` | **19** | **0** | `41811 ms` |
| **Total Emulator (`test:emulator`)** | **11 arquivos** | — | **93** | **0** | — |

*(Observação sobre o crescimento do **Lote 1B** de `24` para `31` itens: `src/services/phase8.emulator.test.ts` foi expandida de `8` subtestes — `9` itens no `tsx --test` — para `15` subtestes permanentes — `16` itens no `tsx --test` — com os cenários `9` a `15` de integridade contábil, compensação legítima e testes negativos de segurança.)*

---

## 8. Total Consolidado de Testes (Estado Final Pós-Correções Locais em `homologation/rc1-e2e`)

### 8.1 Rodada Final Executada Após as Últimas Alterações Locais

| Camada / Suíte | Comando / Escopo | Aprovados (Reportado) | Reprovados | Status / Base da Execução |
| :--- | :--- | :---: | :---: | :--- |
| Typecheck | `npm run typecheck` | — | — | **Aprovado (`0` erros)** (pós-correção Demo) |
| Build | `npm run build` | — | — | **Aprovado (`dist/` gerado em `1.01 s`)** (pós-correção Demo) |
| Suíte focada Modo Demo (Fase 8) | `npx tsx --test src/services/acquisitionsService.test.ts` | **17** | **0** | **Aprovado** (pós-correção Demo; subconjunto já incluído no `npm test` abaixo) |
| Testes gerais (13 arquivos / 14 suítes) | `npm test` | **184** | **0** | **Aprovado** (`5994 ms`, pós-correção Demo) |
| Firebase Emulator — Lote 1A (4 arquivos) | `firestore.rules.test.ts`, `phase34`, `phase5`, `phase6` | **43** | **0** | **Aprovado** (alvos Cloud Functions/Rules inalterados após esta rodada) |
| Firebase Emulator — Lote 1B (3 arquivos) | `phase7`, `phase8`, `phase9` | **31** | **0** | **Aprovado** (ramo `!isDemo` e `functions/index.js` inalterados após esta rodada) |
| Firebase Emulator — Lote 2 (4 arquivos) | `extratoUniversalForm`, `spaceCreationFlow`, `rc1Audit`, `invitesAndLedgers` | **19** | **0** | **Aprovado** (alvos Cloud Functions/Rules inalterados após esta rodada) |
| **Subtotal consolidado (`npm test` + `test:emulator`)** | **`npm test` + 3 lotes do `test:emulator`** | **277** | **0** | **100% Aprovado** *(sem contar a execução isolada de `acquisitionsService.test.ts` separadamente para evitar dupla contagem)* |

### 8.2 Execuções Complementares Documentadas em Etapas Anteriores (Alvos Não Alterados Posteriormente)

| Verificação Complementar | Comando / Arquivo | Aprovados (Reportado) | Reprovados | Momento da Execução |
| :--- | :--- | :---: | :---: | :--- |
| **Storage Security Rules** | `storage.rules.test.ts` (Storage Emulator) | **5** | **0** | Executado imediatamente após a alteração de `storage.rules` (inalterada desde então). |
| **Cenário Completo (Alice & Bob)** | `npm run test:scenario` (`twoUsersScenario.emulator.test.ts`) | **8** | **0** | Executado no commit-base `04761b8` (não reexecutado após ajustes restritos a Storage/aquisições). |
| **Regras Firestore isoladas** | `npm run test:rules` (`firestore.rules.test.ts`) | **16** | **0** | Executado no commit-base `04761b8`; **já incluído e reexecutado integralmente no Lote 1A** acima. |

### 8.3 Auditoria da Contagem e Sobreposições

Os totais acima representam **execuções reportadas pelo runner `tsx --test` (`ℹ tests`)** e **não devem ser somados mecanicamente como número absoluto de "casos únicos"** sem considerar a estrutura das suítes e as camadas de teste:

1. **Sem sobreposição de arquivos dentro do subtotal (`277`):**
   - `npm test` executa 13 arquivos unitários/em memória (`184` itens, incluindo os `17/17` de `src/services/acquisitionsService.test.ts`; não inclui nenhum `.emulator.test.ts` nem `firestore.rules.test.ts`).
   - Os lotes **1A**, **1B** e **2** executam 11 arquivos distintos entre si (`93` itens: `firestore.rules.test.ts` + 10 arquivos `.emulator.test.ts`), sobre `functions/index.js`, `firestore.rules` e o ramo `!isDemo`, que permaneceram inalterados durante o ajuste final exclusivo do modo Demo.
2. **Sobreposição direta caso se adicione `npm run test:rules` ou a execução isolada de `acquisitionsService.test.ts`:**
   - `src/services/firestore.rules.test.ts` (`16` itens) integra `npm run test:rules` **e também** o **Lote 1A** (`43` itens). Por isso `test:rules` está listado em seção separada (Tabela 8.2) e não é somado novamente ao subtotal `277`.
   - Da mesma forma, `npx tsx --test src/services/acquisitionsService.test.ts` (`17` itens) já faz parte do `npm test` (`184` itens) e não é somado em duplicidade no subtotal `277`.
3. **Limitações para apurar "casos únicos" em toda a base:**
   - Suítes unitárias em memória (`npm test`) e suítes no Emulator Suite (`Lotes 1A/1B/2`, `test:scenario`) validam regras de negócio correlatas em camadas diferentes, podendo testar comportamentos equivalentes.
   - Além disso, o runner `node:test`/`tsx --test` contabiliza tanto blocos `test(...)` agregadores quanto subtestes `t.test(...)` internos no total de `tests` (por exemplo: `firestore.rules.test.ts` = 1 bloco + 15 subtestes = `16`; `phase8.emulator.test.ts` = 1 bloco + 15 subtestes = `16`; `storage.rules.test.ts` = 1 bloco + 4 subtestes = `5`; `twoUsersScenario.emulator.test.ts` = 1 bloco + 7 subtestes = `8`).
4. **Registro complementar (etapa E2E anterior, commit `55e3829`):**
   - Documentado em `docs/reports/RC1-E2E-HOMOLOGATION-REPORT.md`: 4 suítes Playwright em Chromium real (`e2e-suite1.mjs` a `e2e-suite4.mjs`), 11 sondas REST HTTP 403 e 15 verificações responsivas aprovadas.

---

## 9. Confirmação de Encerramento dos Emuladores

Em todos os lotes da rodada final (**Lote 1A**, **Lote 1B** e **Lote 2**), bem como nas execuções anteriores (`test:rules`, `test:scenario`, `storage.rules.test.ts`), o `firebase emulators:exec` concluiu o desligamento completo ao término de cada lote (`Stopping Functions Emulator`, `Stopping Firestore Emulator`, `Stopping Authentication Emulator`, `Stopping Storage Emulator`, `Stopping Eventarc Emulator`, `Stopping Cloud Tasks Emulator`, `Stopping emulator hub` e `Stopping Logging Emulator`).

Após o encerramento do último lote, a verificação de rede (`ss -tlnp`) confirmou todas as portas dos emuladores (`8080`, `5001`, `9099`, `9199`, `4000`, `9150`) livres e nenhum processo dos emuladores ativo.

---

## 10. Problemas Encontrados e Respectivas Soluções

### 10.1 Correções funcionais, de UI, regras e segurança (consolidadas em `55e3829`)

Conforme detalhado em `docs/reports/RC1-E2E-HOMOLOGATION-REPORT.md` e `docs/reports/RC1-SECURITY-AND-RELEASE-AUDIT.md`:

- **7 defeitos comprovados no E2E corrigidos:**
  1. Filtro `scopeType == 'shared'` adicionado em `countSpaceRecords` (`src/services/spaceDissolutionService.ts`) para conformidade com `firestore.rules`.
  2. Compras no cartão de crédito promovidas autoritativamente para `effectiveStatus = 'paid'` (`functions/index.js`, `src/services/personalTransactionService.ts`, `src/components/UniversalTransactionModal.tsx`), consumindo limite e lançando na fatura sem duplicar despesa no pagamento da fatura.
  3. Recarga silenciosa de abas em `src/components/spaces/SharedFinanceSectionV3.tsx` ao alternar sub-abas.
  4. Geração de `idempotencyKey` única por tentativa em declarações e restituições (`SharedFinanceSectionV3.tsx`).
  5. Filtro `snapshot.metadata.hasPendingWrites` em `src/services/acquisitionsFirebase.ts` para evitar corrida em listeners ao criar listas.
  6. Regra restrita em `firestore.rules` permitindo exclusivamente ao criador reabrir dissolução após cancelamento anterior (coberta pelo Teste #12).
  7. Ajuste de inputs monetários para `step="0.01"` e `flex-wrap` no rodapé dos cards em `src/components/acquisitions/WorkspaceBoardView.tsx`.
- **Endurecimentos da auditoria de segurança corrigidos:**
  1. Validação de titularidade e arquivamento da conta de cartão em `executeServerSideCreateInstallmentContract` (`functions/index.js`).
  2. Helper `assertAcquisitionListWriteAccessServer` aplicado às 5 Cloud Functions de aquisição (`functions/index.js`).
  3. Bloqueio de escrita client-side direta em `installment_contracts`, restrição de `update` em `recurrence_rules` (`status`, `updatedAt`), travas de imutabilidade em `acquisition_lists`/`items`/`shared_expenses`, regra explícita para `purchase_reversals` e validação de `spaceStatus` ativo em recorrências/parcelamentos.
  4. Remoção de whitespace excedente (`git diff --check` limpo).

### 10.2 Correção das dependências de Cloud Functions e compatibilidade do Emulator (consolidada em `04761b8`)

- **Problema identificado:**
  1. `functions/package.json` não declarava `"dependencies"`, gerando o aviso `"The Cloud Functions emulator requires the module firebase-admin to be installed as a dependency"` e impedindo empacotamento autônomo em `functions/`.
  2. Ao declarar `firebase-functions@^7.4.0` e `firebase-admin@^14.5.0` em `functions/package.json`, o `firebase-tools@13.35.1` falhava no runtime do emulador ao invocar `localFunctionsModule.config()` (removido no `firebase-functions` v7).
  3. A versão mais recente `firebase-tools@15.36.0` exigia JDK 21+ e falhava nesta VM com OpenJDK 17.
- **Solução aplicada (`04761b8`):**
  1. Declaradas `"firebase-admin": "^14.5.0"` e `"firebase-functions": "^7.4.0"` em `functions/package.json` e instalado `functions/node_modules` com geração de `functions/package-lock.json`.
  2. Atualizado `firebase-tools` na raiz (`package.json` e `package-lock.json`) de `^13.35.1` para `^14.27.0` (`14.27.0` instalada), versão estável compatível simultaneamente com `firebase-functions@7.4.0` (ignora `initializeFunctionsConfigHelper` para v7+) e com Java 17.
  3. Validado o carregamento limpo das **50 Cloud Functions** sem aviso de `firebase-admin` e sem erro de `functions.config()`.

### 10.3 Correção da regra de Storage em `/spaces/{spaceId}/{allPaths=**}` (aplicada localmente em `homologation/rc1-e2e`, ainda não commitada)

- **Problema identificado:**
  - `storage.rules` mantinha `allow read, write: if request.auth != null;` para `/spaces/{spaceId}/{allPaths=**}`, permitindo acesso indiscriminado a qualquer usuário autenticado no projeto caso a regra fosse publicada em produção.
- **Solução aplicada localmente (sem commit até o momento):**
  1. Substituída a regra de `/spaces/{spaceId}/{allPaths=**}` em `storage.rules#L7-L9` por negação explícita (`allow read, write: if false;`), preservando integralmente `users/{userId}/{allPaths=**}` (`allow read, write: if request.auth != null && request.auth.uid == userId;`).
  2. Confirmado em código (`src/services/acquisitionsFirebase.ts#L514-L538` e chamadores em `AuthModal.tsx`, `SettingsView.tsx` e `WorkspaceBoardView.tsx`) que todas as funcionalidades atuais da aplicação (`avatars`, `receipts` e `products`) utilizam exclusivamente `users/{uid}/...`, sem qualquer dependência de `/spaces/`.
  3. Criada e aprovada a suíte `src/services/storage.rules.test.ts` (`5/5`) no Storage Emulator e revalidado `src/services/phase5.emulator.test.ts` (aprovado também no Lote 1A final).
  4. **Situação no Git:** alteração realizada na árvore de trabalho da branch `homologation/rc1-e2e`, **ainda não commitada**.

### 10.4 Correção da integridade contábil, atomicidade transacional e estorno de aquisições (aplicada localmente em `homologation/rc1-e2e`, ainda não commitada)

- **Diagnóstico reproduzido e confirmado no Firebase Emulator:**
  1. `acquisitionCheckoutOfficial` aceitava e gravava `disbursements[].sourceAccountId` sem debitar a conta informada.
  2. `executeServerSideReverseAcquisitionPurchase` executava escritas (`tx.set`/`tx.update`) antes de `tx.get(accRef)`, violando a regra do Firestore (`Firestore transactions require all reads to be executed before all writes`).
  3. O fluxo antigo de compensação gerava ID `mov_...` em desacordo com `reversalOfMovementId` (que esperava o padrão `rev_...` vinculado ao débito original) e podia creditar a conta no estorno sem existência de débito prévio no checkout, gerando inflação indevida de saldo.
- **Solução aplicada localmente em `functions/index.js` e `src/services/acquisitionsService.ts` (sem commit até o momento):**
  1. **Bloqueio de `sourceAccountId` no checkout:** `executeServerSideAcquisitionCheckout` (`functions/index.js#L7264-L7273`, `#L7349-L7355`) e `recordAcquisitionPurchase` em modo demo (`src/services/acquisitionsService.ts#L610-L614`, `#L648-L653`) rejeitam qualquer `disbursements[].sourceAccountId` não vazio (`invalid-argument` no backend / erro equivalente no demo) e não persistem `sourceAccountId` (`sourceAccountId: null` no backend; campo omitido no modo demo).
  2. **Atomicidade Firestore (leituras antes de escritas):** `executeServerSideReverseAcquisitionPurchase` (`functions/index.js#L7723-L7855`) executa todas as leituras transacionais (`accSnap`, consulta de `movements` por `originId == purchaseId` e verificação determinística do documento `rev_...`) **antes de qualquer escrita (`tx.set`/`tx.update`)**.
  3. **Compensação financeira estritamente condicionada a débito legítimo e verificável:** o estorno só gera movimento compensatório quando existe débito real e não estornado vinculado à compra (`originType === 'acquisition_checkout'`, `direction === 'outflow'`, `originId === purchaseId`, `!reversalOfMovementId`, `amountCents === disbursedAmountCents`, `userId === funderUid`) em conta ativa (`!isAccountArchivedServer`) pertencente ao titular do desembolso (`accData.userId === expectedFunderUid`).
  4. **Bloqueio de compras históricas sem débito ou com inconsistência:** compras com `sourceAccountId` que não possuam débito original verificável (ou cuja conta seja inexistente, arquivada ou de outro titular) são bloqueadas com `failed-precondition` e **zero mutações parciais** em item, estoque, `purchase_reversals`, `audit` ou saldo da conta.
  5. **Padrão `rev_...`, idempotência e semântica `acquisition_reversal`:** o movimento compensatório é gerado via `serverGenerateReversalDocId(matchedDebit.id)` (`rev_...`), referencia `reversalOfMovementId: rev.originalDebit.id`, usa `idempotencyKey: 'reversal_' + rev.originalDebit.id` (impedindo duplicidade mesmo em replay com `idempotencyKey` diferente na chamada) e adota `originType: 'acquisition_reversal'` (`functions/index.js#L7919` e `src/services/acquisitionsService.ts#L854`), compatível com `src/types/financeV3.ts#L67` e mapeado para `'Aquisições'` em `src/services/ledgerService.ts#L331-L332`.
  6. **Correção de pré-validação e sequenciamento no modo Demo (`src/services/acquisitionsService.ts#L766-L943`):** o ramo `isDemo === true` de `reverseAcquisitionPurchase` anteriormente podia gravar movimentação de estoque e atualizar o item antes de `recordMovement` rejeitar conta arquivada/inexistente. Passou a executar **validação prévia completa** (existência e não arquivamento em `mpf_v3_demo_accounts`, titularidade `funderUid`, débito verificável em `mpf_v3_demo_movements`, checagem de `alreadyReversed` e pré-validação em memória via `buildFinancialMovement`) e **preparação integral dos dados em memória** (estoque, item e `reversalRecord`) antes de iniciar a **persistência sequenciada** no `universalStorage` (`localStorage`). Essa alteração não torna o modo Demo transacionalmente atômico como o Firestore: falhas inesperadas durante a sequência de gravação local ainda não possuem garantia de rollback transacional.
- **Cobertura permanente de testes adicionada e validada:**
  1. **Unitários (`src/services/acquisitionsService.test.ts`, `17/17` aprovados):**
     - Testes `9` e `10`: rejeição de checkout com `sourceAccountId` (Teste `9`) e bloqueio de estorno de compra histórica sem débito verificável, com checagem de item e ausência de `purchase_reversals` em modo demo (Teste `10`).
     - Testes `11` a `14` *(novos cenários negativos no modo Demo com verificação integral de snapshot antes/depois das 7 chaves `universalStorage`)*: conta arquivada (`11`), conta inexistente (`12`), conta pertencente a outro usuário (`13`) e conta válida com débito original inexistente (`14`) — todos bloqueados com **zero alterações parciais** em lista, item, compra, estoque, movimentos financeiros, saldo ou registros de estorno.
     - Teste `15`: débito original já estornado previamente no ledger — conclui o estorno operacional sem duplicar movimento compensatório nem inflacionar o saldo.
     - Teste `16`: estorno válido em modo Demo — cria compensação legítima (`rev_...`, `originType: 'acquisition_reversal'`, `reversalOfMovementId`), restaura saldo (`100000`), decrementa estoque (`5 -> 2`, `reversal_outflow`) e registra o estorno.
     - Teste `17`: repetição da mesma solicitação (mesma `idempotencyKey` e chave divergente) — preserva idempotência (`isIdempotentReplay: true`) e snapshot integral inalterado.
  2. **Emulator Fase 8 (`src/services/phase8.emulator.test.ts`, Testes `9` a `15`):**
     - Testes `9–11`: checkout normal e estorno sem `sourceAccountId`, incluindo replay idempotente sem dupla alteração de estoque/saldo.
     - Teste `12`: checkout com `sourceAccountId` rejeitado com `invalid-argument` sem persistir compra nem alterar estoque ou saldo.
     - Teste `13`: compras históricas (recorrente e objetivo) com `sourceAccountId` sem débito bloqueadas com `failed-precondition` e zero mutações parciais.
     - Teste `14` *(compensação financeira legítima permanente)*: conta de R$ 1.000,00 com débito real de R$ 300,00 (`acquisition_checkout`); estorno pela Cloud Function oficial gera exatamente 1 entrada compensatória `rev_...` com `originType: 'acquisition_reversal'`, `reversalOfMovementId` apontando ao débito e saldo restaurado para R$ 1.000,00; segunda tentativa com `idempotencyKey` diferente retorna replay idempotente sem duplicar crédito nem decrementar estoque novamente.
     - Teste `15` *(testes negativos de segurança permanentes)*: valida bloqueio com zero mutações parciais em 7 cenários adversariais — conta inexistente (`15A`), conta arquivada (`15B`), conta pertencente a outro usuário (`15C`), ausência de débito original (`15D`), débito com valor divergente (`15E`), débito com `originType` incompatível (`15F-1`) e movimento semeado com `userId` incompatível (`15F-2`).
  3. **Situação no Git:** alterações realizadas na árvore de trabalho da branch `homologation/rc1-e2e`, **ainda não commitadas**.

---

## 11. Ressalvas de Ambiente

1. **Node.js solicitado `22` vs executado `24`:**
   - `functions/package.json` (`engines.node: "22"`) e `firebase.json` (`runtime: "nodejs22"`) especificam Node 22, enquanto o host local executa Node `v24.22.2` (`⚠ functions: Your requested "node" version "22" doesn't match your global version "24". Using node@24 from host.`). Recomenda-se validar explicitamente em ambiente/CI com Node 22 antes do deploy remoto.
2. **Java 17 e aviso de compatibilidade futura do Firebase CLI:**
   - O ambiente utiliza `OpenJDK 17.0.21`. O `firebase-tools@14.27.0` funciona normalmente com Java 17, emitindo apenas o aviso informativo: `firebase-tools will drop support for Java version < 21 soon in firebase-tools@15. Please install a JDK at version 21 or above to get a compatible runtime.` Qualquer atualização futura para `firebase-tools@15+` exigirá JDK 21+.
3. **Limitação de memória ao executar `npm run test:emulator` em sessão única:**
   - O 1º bloco do script `test:emulator` em `package.json` dispara 7 suítes seguidas na mesma sessão do Functions Emulator (`RuntimeWorkerPool` em modo `AUTO`), mantendo cerca de ~40 workers Node residentes (~195 MB RSS cada). Em VMs de 8 GB de RAM sem swap, o consumo atinge ~7,9 GB e o OOM killer encerra o processo Java do Firestore Emulator com `SIGKILL` durante `phase8`. A divisão da execução em 3 lotes sequenciais (`Lote 1A`, `Lote 1B` e `Lote 2`) elimina o esgotamento de memória e aprova todas as **93/93** execuções reportadas (`43 + 31 + 19`) sem falhas.

---

## 12. Pendências, Limitações Explícitas e Recomendações Antes de Produção

> **Pendências e ressalvas anteriormente identificadas e resolvidas localmente em `homologation/rc1-e2e` (aguardando commit):**
> 1. **Storage (`/spaces/{spaceId}/{allPaths=**}`):** corrigida em `storage.rules#L7-L9` para `allow read, write: if false;` e validada com `storage.rules.test.ts` (`5/5`). Todas as funcionalidades atuais operam exclusivamente em `users/{uid}/...`.
> 2. **Ordem de leitura após escrita e integridade contábil em `executeServerSideReverseAcquisitionPurchase`:** o risco condicional latente de leitura após escrita (`tx.get` após `tx.update`/`tx.set`) e a geração potencial de crédito sem débito foram **eliminados** em `functions/index.js` e validados pelos testes permanentes `9` a `15` da Fase 8 no Firebase Emulator (`Lote 1B`, `31/31`).
> 3. **Ressalva do estorno em modo Demo (`reverseAcquisitionPurchase`, `isDemo === true`):** encerrada dentro do escopo aplicável ao armazenamento local (`src/services/acquisitionsService.ts#L766-L943`). A rotina agora realiza **validação prévia completa** (contas em `mpf_v3_demo_accounts`, titularidade, existência/correspondência de débito em `mpf_v3_demo_movements`, checagem de estorno prévio e pré-validação via `buildFinancialMovement`), **preparação integral dos dados em memória** e **persistência sequenciada somente após aprovação**, protegendo contra mutações parciais nos cenários negativos com snapshot integral antes/depois cobertos pelos testes `11` a `14` (além do bloqueio de estorno histórico sem débito no teste `10`) de `src/services/acquisitionsService.test.ts` (`17/17`). *Delimitação técnica explícita:* o modo Demo não possui atomicidade transacional equivalente ao Firestore — falhas inesperadas durante a sequência de gravação local no `universalStorage` (`localStorage`) ainda não possuem garantia de rollback transacional.

### 12.1 Limitações Funcionais e Pré-Requisitos Obrigatórios Antes de Produção

1. **Débito automático no checkout de aquisições — Indisponível (bloqueio intencional):**
   - O débito automático de conta bancária durante o checkout de aquisições (`disbursements[].sourceAccountId`) **continua indisponível** e é explicitamente rejeitado com `invalid-argument` tanto em `executeServerSideAcquisitionCheckout` quanto no modo demo. Caso venha a ser habilitado em versão futura, exigirá implementação transacional do débito no checkout e nova bateria de validação.
2. **Garantia de rollback no modo Demo (`universalStorage` / `localStorage`):**
   - Embora todos os cenários negativos previsíveis (conta inexistente, arquivada, de outro usuário e ausência de débito) sejam bloqueados antes de qualquer escrita, o modo Demo persiste múltiplas chaves locais sequencialmente sem mecanismo de rollback transacional em caso de falha inesperada durante a escrita.
3. **Consolidação Git das alterações locais na branch de homologação:**
   - Consolidar em commit na branch `homologation/rc1-e2e` as alterações já validadas localmente (`functions/index.js`, `src/services/acquisitionsService.ts`, `src/services/acquisitionsService.test.ts`, `src/services/phase8.emulator.test.ts`, `storage.rules`, `src/services/storage.rules.test.ts` e `docs/RC1-FINAL-HOMOLOGATION-REPORT.md`).
4. **Configuração e validação de ambiente remoto pré-deploy:**
   - Definir projeto Firebase alvo de produção fora de `.firebaserc` (que aponta apenas para `demo-projeto-beta-v3`).
   - Validar execução das 50 Cloud Functions em runtime **Node 22** (conforme `engines.node: "22"` / `firebase.json`), revisar índices Firestore, variáveis de ambiente, CORS/App Check e planejar publicação coordenada de `firestore.rules`, `storage.rules` e `functions`.

### 12.2 Recomendações Futuras (Melhoria / Manutenção — Não Bloqueantes)

1. **Ajuste opcional do script `test:emulator` em `package.json`:**
   - Em manutenção futura, considerar dividir o 1º bloco de `scripts["test:emulator"]` em duas sessões (`Lote 1A` e `Lote 1B`) para evitar pico de memória em hosts/runners de CI com 8 GB de RAM sem swap, bem como integrar `src/services/storage.rules.test.ts` ao script de regras.
2. **Versionamento opcional dos scripts Playwright E2E (`e2e-suite1..4.mjs`):**
   - Caso a equipe deseje incorporá-los à esteira contínua, mover os scripts da etapa E2E para o repositório em commit próprio.

---

## 13. Conclusão Técnica

1. **Homologação Técnica RC1 — APROVADA EM AMBIENTE LOCAL (COM ALTERAÇÕES PENDENTES DE COMMIT):**
   - Sobre o estado atual da branch `homologation/rc1-e2e` (commit-base `04761b8` + correções locais de Storage, integridade contábil/estorno de aquisições e pré-validação/sequenciamento em modo Demo), todas as verificações automatizadas concluíram com **0 falhas** em ambiente local: `npm run typecheck` aprovado (`0` erros), `npm run build` aprovado (`vite v8.3.7`, `1.01 s`), `src/services/acquisitionsService.test.ts` aprovado (**17/17**) e `npm test` aprovado com **184/184** em 14 suítes (`5994 ms`) após a correção final do modo Demo; sobre os alvos inalterados de Cloud Functions, Regras e suítes `.emulator.test.ts`, a execução sequencial completa dos 3 lotes do Firebase Emulator aprovou **93/93** (`Lote 1A: 43/43`, `Lote 1B: 31/31`, `Lote 2: 19/19`), com carregamento íntegro das 50 Cloud Functions sem erros de `functions.config()` nem avisos de `firebase-admin` e encerramento limpo dos emuladores. Complementarmente, `storage.rules.test.ts` (`5/5` pós-correção de `storage.rules`), `npm run test:rules` (`16/16` no `04761b8`, revalidado no Lote 1A) e `npm run test:scenario` (`8/8` no `04761b8`) registraram **0 falhas**.
2. **Pendências de Segurança e Integridade Contábil — RESOLVIDAS E COBERTAS POR TESTES PERMANENTES:**
   - A exposição de Storage em `/spaces/{spaceId}/{allPaths=**}` (`allow read, write: if false;`) e o risco transacional/contábil de `executeServerSideReverseAcquisitionPurchase` (leitura antes de escrita no Firestore, bloqueio de `sourceAccountId` no checkout, compensação legítima com padrão `rev_...` / `originType: 'acquisition_reversal'` e bloqueio histórico sem débito) estão corrigidos na árvore de trabalho local de `homologation/rc1-e2e` e protegidos por testes permanentes de regressão e segurança (incluindo Testes `9–15` de `src/services/phase8.emulator.test.ts`). No modo Demo (`src/services/acquisitionsService.ts`), a ressalva de mutação prévia à validação de conta/débito foi encerrada com validação prévia completa, preparação em memória e persistência sequenciada, coberta pelos Testes `11–17` (além do Teste `10`) de `src/services/acquisitionsService.test.ts` (mantida a ressalva técnica de que gravações sequenciais em `localStorage` não possuem rollback transacional para falhas inesperadas em tempo de escrita).
3. **Limitações Funcionais e Pré-Requisitos Remotos — MANTIDOS EXPLÍCITOS:**
   - O débito automático de contas no checkout de aquisições **permanece indisponível** (`sourceAccountId` bloqueado com `invalid-argument`). Permanece pendente o commit das alterações locais na branch `homologation/rc1-e2e`, além dos pré-requisitos operacionais de ambiente remoto (projeto de produção distinto de `demo-projeto-beta-v3`, validação em Node 22, revisão de índices Firestore e App Check/CORS).
4. **Ausência de Deploy e de Autorização para Produção (`firebase deploy`):**
   - **Nenhum deploy foi realizado** e **este relatório NÃO autoriza publicação em produção (`firebase deploy`)**. A liberação para ambiente remoto permanece condicionada à consolidação Git das alterações locais, revisão do responsável pela liberação e atendimento integral dos pré-requisitos de ambiente remoto.
