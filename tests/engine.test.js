// 计算引擎回归测试
// 跑法：node tests/engine.test.js
// 覆盖：表头识别 → 指标口径 → 分规格聚合 → 无参数表降级 → 建议价规则
// 改过 assets/engine/ 里任何文件后必须跑这一份。

const path = require('path')
const ENGINE = path.resolve(__dirname, '../assets/engine')

const C = require(path.join(ENGINE, 'compute.js'))
const I = require(path.join(ENGINE, 'ingest.js'))
const { buildAdvice } = require(path.join(ENGINE, 'advice.js'))

const checks = []
function eq(name, actual, expect) {
  const a = Number(actual)
  const e = Number(expect)
  const ok = isFinite(a) && Math.abs(a - e) < 0.005
  checks.push({ ok, name, actual, expect: e })
}
function is(name, actual, expect) {
  checks.push({ ok: actual === expect, name, actual, expect })
}

// ---------- 1. ingest：表头识别与记录提取 ----------
const orderRows = [
  ['导出时间 2026-09-05', '', '', ''],
  ['订单号', '规格ID', 'SKU规格', 'SKU件数', '商家应收金额(元)（支付金额）', '包裹总运费(元)', '店铺优惠(元)', 'SKU商家改价(元)', '售后状态', '省', '支付时间'],
  ['A001', 'SP-A', 'A 款 S', '1', '12', '5', '2', '0', '无', '广东省', '2026-09-01 10:00:00'],
  ['A002', 'SP-A', 'A 款 S', '1', '12', '5', '0', '0', '无', '浙江省', '2026-09-02 11:00:00'],
  ['A003', 'SP-B', 'B 款 M', '2', '30', '6', '3', '5', '无', '广东省', '2026-09-03 12:00:00'],
  ['A004', 'SP-B', 'B 款 M', '1', '30', '6', '0', '0', '退款成功', '江苏省', '2026-09-04 13:00:00'],
  ['A005', 'SP-C', 'C 款 L', '1', '50', '8', '0', '0', '无', '广东省', '2026-09-05 14:00:00']
]
const orders = I.normalizeOrders(orderRows)
is('ingest 表头行', orders.headerRow, 2)
is('ingest 记录数', orders.records.length, 5)
is('ingest 缺失列', orders.missing.length, 0)
eq('ingest 合计销售额', orders.summary.netSales, 134)
eq('ingest 售后行数', orders.summary.refundRows, 1)
is('ingest 日期范围', orders.summary.dayFrom + '~' + orders.summary.dayTo, '2026-09-01~2026-09-05')

// ---------- 2. compute：全部指标 ----------
const params = { rows: [{ sp: 'SP-A', cost: 4 }, { sp: 'SP-B', cost: 10 }] }
const snap = C.buildSnapshot({
  orders: orders,
  params: params,
  options: { ads: 10, platformFee: 5 }
})

// 有效行 A001/A002/A003/A005 合计 104；A004 整单退 30 单独计
eq('净销售额', snap.kpi.net_sales, 104)
eq('有效订单', snap.kpi.orders, 4)
eq('退款单数', snap.kpi.refund_orders, 1)
eq('退款额', snap.kpi.refund_amount, 30)
eq('退款率', snap.kpi.refund_rate, 0.2)
eq('成交件数', snap.kpi.qty, 5)
eq('拿货成本', snap.kpi.cost, 28)
eq('毛利', snap.kpi.gross_profit, 76)
eq('运费', snap.kpi.freight, 24)
eq('履约后利润', snap.kpi.post_fulfill_profit, 52)
eq('经营利润', snap.kpi.operating_profit, 37)
eq('ROI', snap.kpi.roi, 10.4)
eq('客单价', snap.kpi.avg_order_value, 26)
is('期次自动生成', snap.meta.label, '2026-09-01 ~ 2026-09-05')
is('规格数', snap.skus.length, 3)

// 成本：SP-A 2件×4=8，SP-B 2件×10=20，SP-C 缺价按 0 → 28
const skuA = snap.skus.filter(s => s.spec === 'SP-A')[0]
const skuB = snap.skus.filter(s => s.spec === 'SP-B')[0]
const skuC = snap.skus.filter(s => s.spec === 'SP-C')[0]

eq('SP-A 销售额', skuA.sales, 24)
eq('SP-A 订单', skuA.orders, 2)
eq('SP-A 成本', skuA.cost, 8)
eq('SP-A 履约后利润', skuA.post, 6)
eq('SP-A 单均利润', skuA.unit, 3)

eq('SP-B 销售额', skuB.sales, 30)
eq('SP-B 订单', skuB.orders, 1)
eq('SP-B 退款额', skuB.refund_amount, 30)
eq('SP-B 退款率', skuB.refund_rate, 0.5)
eq('SP-B 履约后利润', skuB.post, 4)

is('SP-C 缺拿货价', skuC.missing_cost, true)
eq('SP-C 履约后利润', skuC.post, 42)

// ---------- 3. 没传参数表时的降级 ----------
const noParams = C.buildSnapshot({ orders: orders, params: { rows: [] }, options: {} })
is('无参数表全部标缺价', noParams.skus.every(s => s.missing_cost), true)
is('无参数表有预警', noParams.meta.warnings.some(w => w.indexOf('拿货价') >= 0), true)
is('没填推广费有预警', noParams.meta.warnings.some(w => w.indexOf('推广费') >= 0), true)

// ---------- 4. 建议价规则 ----------
const advised = buildAdvice(snap.skus)
const roleOf = {}
advised.forEach(s => { roleOf[s.spec] = s.role })
is('SP-B 退款率高 → 先治退款', roleOf['SP-B'], '先治退款')
is('SP-C 缺价 → 待核数据', roleOf['SP-C'], '待核数据')

// 整单退款 → 该规格有效订单为 0 → 滞销款
const zeroSnap = C.buildSnapshot({
  orders: { records: [{ o: 'Z1', sp: 'SP-Z', ss: 'Z 款', q: 1, rec: 30, fr: 5, as: '退款成功', t: '2026-09-01' }] },
  params: { rows: [{ sp: 'SP-Z', cost: 5 }] },
  options: {}
})
const zeroAdvice = buildAdvice(zeroSnap.skus)
is('全退规格 → 滞销款', zeroAdvice[0].role, '滞销款')
eq('全退规格有效订单', zeroSnap.skus[0].orders, 0)
eq('全退规格退款额', zeroSnap.skus[0].refund_amount, 30)

// ---------- 汇总 ----------
const bad = checks.filter(c => !c.ok)
checks.forEach(c => {
  console.log((c.ok ? '  ok  ' : ' FAIL ') + c.name + '  实际=' + c.actual + ' 期望=' + c.expect)
})
console.log('\n通过 ' + (checks.length - bad.length) + '/' + checks.length)
if (bad.length) {
  console.log('失败项：' + bad.map(b => b.name).join(', '))
  process.exit(1)
}
