import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers.js';

type RegistryResponse = {
  clients?: Array<{ displayName: string; isDemo: boolean }>;
  accounts?: Array<{ alias: string; isDemo: boolean }>;
  subscriptions?: Array<{ name: string; isDemo: boolean }>;
  projects?: Array<{ title: string; isDemo: boolean }>;
};

function values(body: RegistryResponse, key: keyof RegistryResponse): Array<{ isDemo: boolean }> {
  const result = body[key];
  if (!result) throw new Error(`响应缺少 ${key}`);
  return result;
}

test('登记读取按 real / demo / all 工作区双向隔离', async () => {
  const h = await createHarness();
  try {
    const client = await h.request<{ client: { id: string } }>('POST', '/api/clients', {
      kind: 'codex',
      displayName: '真实客户端',
    });
    const account = await h.request<{ account: { id: string } }>('POST', '/api/accounts', {
      provider: '真实供应商',
      alias: '真实账户',
      currency: 'CNY',
    });
    await h.request('POST', '/api/subscriptions', {
      name: '真实订阅',
      accountId: account.body.account.id,
      priceMinor: '9900',
      currency: 'CNY',
      billingCycle: 'monthly',
      clientIds: [client.body.client.id],
    });
    await h.request('POST', '/api/projects', { title: '真实项目' });

    const seeded = await h.request('POST', '/api/demo/seed');
    assert.equal(seeded.status, 200, JSON.stringify(seeded.body));

    const endpoints: Array<{ url: string; key: keyof RegistryResponse }> = [
      { url: '/api/clients', key: 'clients' },
      { url: '/api/accounts', key: 'accounts' },
      { url: '/api/subscriptions', key: 'subscriptions' },
      { url: '/api/projects', key: 'projects' },
    ];

    for (const { url, key } of endpoints) {
      const real = await h.request<RegistryResponse>('GET', url);
      const realItems = values(real.body, key);
      assert.ok(realItems.length > 0, `${url} 的真实工作区应保留真实登记项`);
      assert.ok(realItems.every((item) => !item.isDemo), `${url} 的真实工作区不得出现示例登记项`);

      const demo = await h.request<RegistryResponse>('GET', `${url}?workspace=demo`);
      const demoItems = values(demo.body, key);
      assert.ok(demoItems.length > 0, `${url} 的示例工作区应显示示例登记项`);
      assert.ok(demoItems.every((item) => item.isDemo), `${url} 的示例工作区不得出现真实登记项`);

      const all = await h.request<RegistryResponse>('GET', `${url}?workspace=all`);
      const allItems = values(all.body, key);
      assert.ok(allItems.some((item) => item.isDemo), `${url} 的 all 工作区应包含示例登记项`);
      assert.ok(allItems.some((item) => !item.isDemo), `${url} 的 all 工作区应包含真实登记项`);
    }
  } finally {
    h.close();
  }
});
