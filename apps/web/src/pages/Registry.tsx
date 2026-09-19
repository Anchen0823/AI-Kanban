import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CLIENT_KINDS, minorUnits, moneyFromDecimal, normalizeCurrency, type ClientKind } from '@aicc/core';
import {
  api,
  type AccountRecord,
  type ClientRecord,
  type ProjectRecord,
  type SubscriptionRecord,
} from '../api.js';
import type { PageProps } from '../App.js';
import { Alert, Badge, Card, EmptyState, Modal, formatMoneyMinor } from '../ui.js';

/**
 * 登记面板：客户端 / 计费账户 / 订阅。
 *
 * 为什么非要有这一页。这三个实体的写接口在服务端早就有了，但没有界面 —— 结果是
 * 「想绑定自己的 Codex / Cursor，前提是先用 curl 手动 POST 一个 client」这种隐形门槛。
 * 更糟的是它会误导：概览页显示「客户端 0」，用户会以为系统不支持自己的工具，
 * 其实只是没法登记。
 *
 * 两条纪律（与设计稿 §5.4 / §10 对应）：
 *
 * 1. **金额不允许经过浮点。** 用户填的是主单位小数（19.99），界面调用 core 的
 *    `moneyFromDecimal` 转成定点整数字符串（"1999"）再提交。界面上同时显示这个字符串，
 *    让用户能核对「我填的和我存的」是不是一回事。
 * 2. **账户表不含任何凭据。** 这个界面连「登录 Cookie」的输入框都没有 ——
 *    不是忘了做，是设计上就拒绝保存。`accountRef` 只收用户自己填的别名/标识。
 */

const CLIENT_KIND_LABEL: Record<ClientKind, string> = {
  chatgpt_app: 'ChatGPT 桌面端',
  chatgpt_web: 'ChatGPT 网页端',
  codex: 'Codex CLI',
  cursor: 'Cursor',
  workbuddy: 'WorkBuddy',
  api_agent: '自建 API Agent',
  other: '其他',
};

const PROVIDER_PRESETS = ['openai', 'anthropic', 'cursor', 'workbuddy', 'azure-openai', 'other'];

const CURRENCY_PRESETS = ['CNY', 'USD', 'JPY', 'EUR', 'HKD'];

const BILLING_CYCLE_LABEL: Record<string, string> = {
  monthly: '按月',
  yearly: '按年',
  other: '其他周期',
};

const SUBSCRIPTION_STATUS_LABEL: Record<string, string> = {
  active: '生效中',
  cancelled: '已取消',
  unknown: '状态未知',
};

export function RegistryPanel({ toast, reload }: { toast: PageProps['toast']; reload: () => void }): ReactNode {
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [section, setSection] = useState<'clients' | 'accounts' | 'subscriptions'>('clients');
  const [creating, setCreating] = useState<'client' | 'account' | 'subscription' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [c, a, s, p] = await Promise.all([
        api.get<{ clients: ClientRecord[] }>('/api/clients'),
        api.get<{ accounts: AccountRecord[] }>('/api/accounts'),
        api.get<{ subscriptions: SubscriptionRecord[] }>('/api/subscriptions'),
        api.get<{ projects: ProjectRecord[] }>('/api/projects'),
      ]);
      setClients(c.clients);
      setAccounts(a.accounts);
      setSubscriptions(s.subscriptions);
      setProjects(p.projects);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const clientName = useCallback((id: string) => clients.find((c) => c.id === id)?.displayName ?? id, [clients]);
  const accountName = useCallback((id: string | null) => (id ? (accounts.find((a) => a.id === id)?.alias ?? id) : '未绑定账户'), [accounts]);

  const onCreated = useCallback(async () => {
    setCreating(null);
    await load();
    reload();
  }, [load, reload]);

  return (
    <div className="stack">
      {error ? <Alert tone="danger" title="加载失败">{error}</Alert> : null}

      <div className="pill-group">
        {(
          [
            ['clients', `客户端（${clients.length}）`],
            ['accounts', `计费账户（${accounts.length}）`],
            ['subscriptions', `订阅（${subscriptions.length}）`],
          ] as const
        ).map(([key, label]) => (
          <button key={key} className={`tag-btn${section === key ? ' active' : ''}`} onClick={() => setSection(key)}>
            {label}
          </button>
        ))}
      </div>

      {section === 'clients' ? (
        <Card
          tight
          title="客户端"
          hint="登记了你实际在用的入口，用量才能归属、凭据才有绑定对象"
          actions={
            <button className="primary small" onClick={() => setCreating('client')}>
              登记客户端
            </button>
          }
        >
          {clients.length === 0 ? (
            <EmptyState kind="not_configured" title="还没有登记任何客户端">
              <span>先从你真正在用的那个开始 —— 不需要一次填全。</span>
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>类型</th>
                    <th>版本</th>
                    <th>MCP 档案</th>
                    <th>允许的项目范围</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => (
                    <tr key={c.id}>
                      <td>{c.displayName}</td>
                      <td className="tiny">{CLIENT_KIND_LABEL[c.kind as ClientKind] ?? c.kind}</td>
                      <td className="tiny mono">{c.clientVersion ?? <span className="faint">未填</span>}</td>
                      <td className="tiny mono">{c.mcpProfile ?? <span className="faint">未填</span>}</td>
                      <td className="tiny">
                        {c.allowedProjects === null ? (
                          <span className="warn-text">未限定（凭据签发时应另行收紧）</span>
                        ) : c.allowedProjects.length === 0 ? (
                          <span className="danger-text">空列表（等价于无任何项目）</span>
                        ) : (
                          c.allowedProjects.map((id) => projects.find((p) => p.id === id)?.title ?? id).join('、')
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {section === 'accounts' ? (
        <Card
          tight
          title="计费账户"
          hint="只有别名与币种。这张表在结构上就没有地方放登录凭据"
          actions={
            <button className="primary small" onClick={() => setCreating('account')}>
              登记账户
            </button>
          }
        >
          <Alert tone="warn" title="这里不保存、也无法保存任何第三方登录 Cookie 或会话令牌">
            <span>
              不是「我们选择不存」，而是这张表<strong>没有凭据字段</strong>。
              「账户标识」只是你自己起的参考名（比如邮箱的一部分），用来在多个条目之间区分。
            </span>
            <span className="alert-hint">
              因此本工具永远无法替你登录任何平台。用量只能来自你自己导入的账单/配额页面，
              或将来新增的只读本地接口。
            </span>
          </Alert>
          <div className="sep" />
          {accounts.length === 0 ? (
            <EmptyState kind="not_configured" title="还没有登记任何计费账户" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>别名</th>
                    <th>provider</th>
                    <th>账户标识</th>
                    <th>币种</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.id}>
                      <td>{a.alias}</td>
                      <td className="tiny mono">{a.provider}</td>
                      <td className="tiny mono">{a.accountRef ?? <span className="faint">未填</span>}</td>
                      <td className="tiny mono">{a.currency}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {section === 'subscriptions' ? (
        <Card
          tight
          title="订阅"
          hint="一个订阅可以覆盖多个客户端入口，固定费用只登记一次"
          actions={
            <button className="primary small" onClick={() => setCreating('subscription')}>
              登记订阅
            </button>
          }
        >
          {subscriptions.length === 0 ? (
            <EmptyState kind="not_configured" title="还没有登记任何订阅">
              <span>没有订阅也能用：用量与手续费照样可以登记，只是少了一笔固定支出的对照。</span>
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>账户</th>
                    <th>周期</th>
                    <th className="num">金额</th>
                    <th>状态</th>
                    <th>覆盖入口</th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((s) => (
                    <tr key={s.id}>
                      <td>
                        {s.name}
                        {s.plan ? <div className="faint tiny">{s.plan}</div> : null}
                      </td>
                      <td className="tiny">{accountName(s.accountId)}</td>
                      <td className="tiny">{BILLING_CYCLE_LABEL[s.billingCycle] ?? s.billingCycle}</td>
                      <td className="num tiny">{formatMoneyMinor(s.priceMinor, s.currency)}</td>
                      <td className="tiny">
                        <Badge tone={s.status === 'active' ? 'ok' : s.status === 'cancelled' ? 'danger' : 'warn'}>
                          {SUBSCRIPTION_STATUS_LABEL[s.status] ?? s.status}
                        </Badge>
                        {s.renewAt ? <div className="faint">续费 {s.renewAt}</div> : null}
                      </td>
                      <td className="tiny">
                        {s.clientIds.length === 0 ? (
                          <span className="faint">未绑定入口</span>
                        ) : (
                          s.clientIds.map(clientName).join('、')
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="sep" />
          <div className="notice">
            同一笔订阅的分期扣款请在「用量与订阅 → 收费流水」里另记账目；订阅本身只表达
            「这个周期应该付多少」，两者不会互相推算，也不会自动合并。
            周期与状态都支持「未知」——不知道就填未知，不要猜一个看起来合理的值。
          </div>
        </Card>
      ) : null}

      {creating === 'client' ? (
        <CreateClientModal projects={projects} onClose={() => setCreating(null)} onDone={onCreated} toast={toast} />
      ) : null}
      {creating === 'account' ? (
        <CreateAccountModal onClose={() => setCreating(null)} onDone={onCreated} toast={toast} />
      ) : null}
      {creating === 'subscription' ? (
        <CreateSubscriptionModal
          accounts={accounts}
          clients={clients}
          onClose={() => setCreating(null)}
          onDone={onCreated}
          toast={toast}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 金额输入                                                            */
/* ------------------------------------------------------------------ */

/**
 * 按主单位小数录入，实时显示将要写入的定点整数字符串。
 *
 * 这个「把中间值给用户看」的动作不是装饰：金额一旦进库就是字符串定点整数，
 * 如果界面默默换算、用户又填错了一位小数点，事后很难追溯到。
 */
function AmountInput({
  value,
  currency,
  onChange,
}: {
  value: string;
  currency: string;
  onChange: (decimal: string) => void;
}): ReactNode {
  const parsed = useMemo(() => {
    try {
      return moneyFromDecimal(value, currency);
    } catch {
      return null;
    }
  }, [value, currency]);

  const digits = useMemo(() => {
    try {
      return minorUnits(normalizeCurrency(currency));
    } catch {
      return 2;
    }
  }, [currency]);

  return (
    <div className="stack" style={{ gap: 4 }}>
      <input
        value={value}
        inputMode="decimal"
        onChange={(e) => onChange(e.target.value)}
        placeholder={digits === 0 ? '例：2000' : digits === 3 ? '例：19.999' : '例：19.99'}
      />
      <span className="help">
        {parsed ? (
          <>
            将存为 <span className="mono">{parsed.amountMinor}</span>（{parsed.currency} 最小单位整数）
          </>
        ) : (
          <span className="warn-text">
            {value.trim() === '' ? '未填写' : `无法解析为金额；${currency} 最多 ${digits} 位小数`}
          </span>
        )}
      </span>
    </div>
  );
}

/** 币种输入：一律转大写，并在旁边给出常见写法到 ISO-4217 的映射结果。 */
function CurrencyInput({ value, onChange }: { value: string; currencySetter?: unknown; onChange: (v: string) => void }): ReactNode {
  const normalized = useMemo(() => {
    try {
      return normalizeCurrency(value);
    } catch {
      return null;
    }
  }, [value]);

  return (
    <div className="stack" style={{ gap: 4 }}>
      <input
        className="mono"
        value={value}
        maxLength={3}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        placeholder="CNY"
        list="registry-currency-presets"
      />
      <datalist id="registry-currency-presets">
        {CURRENCY_PRESETS.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <span className="help">
        {normalized ? (
          <>
            存为 <span className="mono">{normalized}</span>
            {value.trim().toUpperCase() !== normalized ? <> · 已把「{value.trim().toUpperCase()}」归并到同一币种</> : null}
          </>
        ) : (
          <span className="warn-text">需要 3 位 ISO-4217 代码（如 CNY / USD / JPY）</span>
        )}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 登记：客户端                                                        */
/* ------------------------------------------------------------------ */

function CreateClientModal({
  projects,
  onClose,
  onDone,
  toast,
}: {
  projects: ProjectRecord[];
  onClose: () => void;
  onDone: () => Promise<void>;
  toast: PageProps['toast'];
}): ReactNode {
  const [kind, setKind] = useState<ClientKind>('codex');
  const [displayName, setDisplayName] = useState('');
  const [clientVersion, setClientVersion] = useState('');
  const [mcpProfile, setMcpProfile] = useState('');
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [unlimited, setUnlimited] = useState(true);
  const [busy, setBusy] = useState(false);

  const ready = displayName.trim().length > 0;

  return (
    <Modal
      title="登记客户端"
      subtitle="登记后才能在「代理凭据」里给它签发令牌，用量也才能归属到具体入口。"
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || !ready}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post('/api/clients', {
                  kind,
                  displayName: displayName.trim(),
                  clientVersion: clientVersion.trim() || null,
                  mcpProfile: mcpProfile.trim() || null,
                  allowedProjects: unlimited ? null : selectedProjects,
                });
                toast(`客户端「${displayName.trim()}」已登记。`, 'ok');
                await onDone();
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'danger');
              } finally {
                setBusy(false);
              }
            }}
          >
            登记
          </button>
        </>
      }
    >
      <div className="stack">
        <label className="field">
          <span>类型</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as ClientKind)}>
            {CLIENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {CLIENT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <span className="help">类型只影响展示与归属，不影响任何权限判断 —— 权限一律由凭据的 scope 决定。</span>
        </label>

        <label className="field">
          <span>显示名称</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoFocus placeholder="例如「我自己的 Codex CLI」" />
        </label>

        <div className="grid cols-2">
          <label className="field">
            <span>版本（可选）</span>
            <input value={clientVersion} onChange={(e) => setClientVersion(e.target.value)} placeholder="例如 0.130.0" />
            <span className="help">版本决定了它支持哪些本地接口。留空表示未知 —— 不要凭印象填。</span>
          </label>
          <label className="field">
            <span>MCP 档案（可选）</span>
            <input value={mcpProfile} onChange={(e) => setMcpProfile(e.target.value)} placeholder="例如 local-aicc" />
          </label>
        </div>

        <div>
          <label className="checkline">
            <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} />
            <span>不限制项目范围（创建后可在签发凭据时单独收紧）</span>
          </label>
          {!unlimited ? (
            <div className="row tight" style={{ marginTop: 6 }}>
              {projects.length === 0 ? (
                <span className="faint tiny">还没有项目，先到「项目」页建一个。</span>
              ) : (
                projects.map((p) => (
                  <label className="checkline" key={p.id}>
                    <input
                      type="checkbox"
                      checked={selectedProjects.includes(p.id)}
                      onChange={(e) =>
                        setSelectedProjects(
                          e.target.checked ? [...selectedProjects, p.id] : selectedProjects.filter((x) => x !== p.id),
                        )
                      }
                    />
                    <span>{p.title}</span>
                  </label>
                ))
              )}
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* 登记：计费账户                                                      */
/* ------------------------------------------------------------------ */

function CreateAccountModal({
  onClose,
  onDone,
  toast,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
  toast: PageProps['toast'];
}): ReactNode {
  const [provider, setProvider] = useState('openai');
  const [alias, setAlias] = useState('');
  const [accountRef, setAccountRef] = useState('');
  const [currency, setCurrency] = useState('CNY');
  const [busy, setBusy] = useState(false);

  const currencyOk = useMemo(() => {
    try {
      normalizeCurrency(currency);
      return true;
    } catch {
      return false;
    }
  }, [currency]);

  const ready = alias.trim().length > 0 && currencyOk;

  return (
    <Modal
      title="登记计费账户"
      subtitle="一个账户大致对应「一份账单」。如果同一个邮箱下有多份计费，就登记成多条。"
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || !ready}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post('/api/accounts', {
                  provider: provider.trim() || 'other',
                  alias: alias.trim(),
                  accountRef: accountRef.trim() || null,
                  currency: currency.trim(),
                });
                toast(`账户「${alias.trim()}」已登记。`, 'ok');
                await onDone();
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'danger');
              } finally {
                setBusy(false);
              }
            }}
          >
            登记
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid cols-2">
          <label className="field">
            <span>provider</span>
            <input value={provider} onChange={(e) => setProvider(e.target.value)} list="registry-provider-presets" />
            <datalist id="registry-provider-presets">
              {PROVIDER_PRESETS.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span>别名</span>
            <input value={alias} onChange={(e) => setAlias(e.target.value)} autoFocus placeholder="例如「个人 ChatGPT Plus」" />
          </label>
        </div>

        <label className="field">
          <span>账户标识（可选）</span>
          <input value={accountRef} onChange={(e) => setAccountRef(e.target.value)} placeholder="自己看得懂就行，例如邮箱前缀" />
          <span className="help">
            只是备注。<strong>不要把 Cookie、API Key 或会话令牌填在这里</strong> —— 它会被明文存进本地数据库并随备份一起导出。
          </span>
        </label>

        <label className="field">
          <span>币种</span>
          <CurrencyInput value={currency} onChange={setCurrency} />
        </label>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* 登记：订阅                                                          */
/* ------------------------------------------------------------------ */

function CreateSubscriptionModal({
  accounts,
  clients,
  onClose,
  onDone,
  toast,
}: {
  accounts: AccountRecord[];
  clients: ClientRecord[];
  onClose: () => void;
  onDone: () => Promise<void>;
  toast: PageProps['toast'];
}): ReactNode {
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [plan, setPlan] = useState('');
  const [priceDecimal, setPriceDecimal] = useState('');
  const [currency, setCurrency] = useState('CNY');
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly' | 'other'>('monthly');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [renewAt, setRenewAt] = useState('');
  const [status, setStatus] = useState<'active' | 'cancelled' | 'unknown'>('active');
  const [clientIds, setClientIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const price = useMemo(() => {
    try {
      return priceDecimal.trim() === '' ? null : moneyFromDecimal(priceDecimal, currency);
    } catch {
      return null;
    }
  }, [priceDecimal, currency]);

  const ready = name.trim().length > 0 && price !== null;

  return (
    <Modal
      title="登记订阅"
      subtitle="固定支出的登记处。同一笔月费即使覆盖五个入口，也只在这里出现一次。"
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || !ready}
            onClick={async () => {
              if (!price) return;
              setBusy(true);
              try {
                await api.post('/api/subscriptions', {
                  name: name.trim(),
                  accountId: accountId || null,
                  plan: plan.trim() || null,
                  priceMinor: price.amountMinor,
                  currency: price.currency,
                  billingCycle,
                  periodStart: periodStart || null,
                  periodEnd: periodEnd || null,
                  renewAt: renewAt || null,
                  status,
                  clientIds,
                });
                toast(`订阅「${name.trim()}」已登记。`, 'ok');
                await onDone();
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'danger');
              } finally {
                setBusy(false);
              }
            }}
          >
            登记
          </button>
        </>
      }
    >
      <div className="stack">
        <label className="field">
          <span>名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="例如「ChatGPT Plus」" />
        </label>

        <div className="grid cols-2">
          <label className="field">
            <span>计费账户（可选）</span>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">不绑定</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.alias}（{a.currency}）
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>套餐（可选）</span>
            <input value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="例如 Plus / Pro / Team" />
          </label>
        </div>

        <div className="grid cols-2">
          <label className="field">
            <span>周期金额</span>
            <AmountInput value={priceDecimal} currency={currency} onChange={setPriceDecimal} />
          </label>
          <label className="field">
            <span>币种</span>
            <CurrencyInput value={currency} onChange={setCurrency} />
          </label>
        </div>

        <div className="grid cols-2">
          <label className="field">
            <span>计费周期</span>
            <select value={billingCycle} onChange={(e) => setBillingCycle(e.target.value as typeof billingCycle)}>
              {Object.entries(BILLING_CYCLE_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>状态</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              {Object.entries(SUBSCRIPTION_STATUS_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <span className="help">不知道就选「状态未知」。这里猜错了会直接影响概览页的支出分桶。</span>
          </label>
        </div>

        <div className="grid cols-2">
          <label className="field">
            <span>周期开始（可选）</span>
            <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
            <span className="help">只精确到天。没有可靠来源时不要补时刻。</span>
          </label>
          <label className="field">
            <span>下次续费（可选）</span>
            <input type="date" value={renewAt} onChange={(e) => setRenewAt(e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span>周期结束（可选）</span>
          <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </label>

        <div>
          <div className="card-hint">这份订阅覆盖哪些入口？</div>
          <div className="row tight" style={{ marginTop: 4 }}>
            {clients.length === 0 ? (
              <span className="faint tiny">还没有登记客户端，先到本页「客户端」那一栏登记。</span>
            ) : (
              clients.map((c) => (
                <label className="checkline" key={c.id}>
                  <input
                    type="checkbox"
                    checked={clientIds.includes(c.id)}
                    onChange={(e) =>
                      setClientIds(e.target.checked ? [...clientIds, c.id] : clientIds.filter((x) => x !== c.id))
                    }
                  />
                  <span>{c.displayName}</span>
                </label>
              ))
            )}
          </div>
          <span className="help">
            多选不会让金额翻倍 —— 固定月费按订阅记一次，入口只是说明「这笔钱买到了哪些使用权」。
          </span>
        </div>
      </div>
    </Modal>
  );
}
