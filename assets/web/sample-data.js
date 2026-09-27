// 示例数据：一期的订单明细 + 拿货价参数表
//
// 为什么要造这么一份，而不是直接内联一份算好的结果：
// 内联结果等于把「算出来的数」写死，示例和引擎会各说各话；这里给的是原始订单行，
// 打开工作台时由同一套引擎现算。示例本身也就成了计算链路的一次真实验证。
//
// 画像刻意覆盖全部规则分支：待核数据 / 滞销 / 先治退款 / 过度款 / 利润款 / 基础款 / 常规款。
// 规模对齐真实那期（净销售额约 4.7k、退款率约 14%、经营利润为负）。

const SKUS = [
  // sp, 名称, 商品, 有效单, 退款单, 销售额, 每单运费, 月份
  { sp: 'SP-B002', sn: '碎花连衣裙(M)', nm: '法式碎花连衣裙', orders: 8, refunds: 1, sales: 1012, fr: 12, month: '10' },
  { sp: 'SP-A002', sn: '基础款开衫(L)', nm: '白色针织开衫', orders: 9, refunds: 1, sales: 786, fr: 8, month: '10' },
  // 拿货价 120 高于售价 → 履约后每单亏钱，用来演示「过度款」
  { sp: 'SP-B001', sn: '碎花连衣裙(S)', nm: '法式碎花连衣裙', orders: 6, refunds: 1, sales: 764, fr: 11, month: '09' },
  { sp: 'SP-F001', sn: '格纹围巾', nm: '羊毛格纹围巾', orders: 8, refunds: 2, sales: 617, fr: 10, month: '10' },
  { sp: 'SP-E001', sn: '圆领毛衣(M)', nm: '圆领羊绒毛衣', orders: 4, refunds: 3, sales: 472, fr: 12, month: '10' },
  { sp: 'SP-D001', sn: '高腰直筒裤(S)', nm: '高腰直筒牛仔裤', orders: 4, refunds: 0, sales: 461, fr: 9, month: '09' },
  { sp: 'SP-C001', sn: '高腰直筒裤(M)', nm: '高腰直筒牛仔裤', orders: 5, refunds: 0, sales: 460, fr: 9, month: '10' },
  { sp: 'SP-A001', sn: '基础款开衫(M)', nm: '白色针织开衫', orders: 4, refunds: 0, sales: 314, fr: 8, month: '09' },
  { sp: 'SP-G001', sn: '针织马甲', nm: '麻花针织马甲', orders: 0, refunds: 0, sales: 0, fr: 8, month: '10' }
]

// 拿货价：SP-F001 故意留空，演示「待核数据」
const PARAMS = [
  { sp: 'SP-B002', cost: 99 },
  { sp: 'SP-A002', cost: 71 },
  { sp: 'SP-B001', cost: 120 },
  { sp: 'SP-F001', cost: null },
  { sp: 'SP-E001', cost: 102 },
  { sp: 'SP-D001', cost: 57 },
  { sp: 'SP-C001', cost: 58 },
  { sp: 'SP-A001', cost: 62 },
  { sp: 'SP-G001', cost: 45 }
]

function pad(n) {
  return (n < 10 ? '0' : '') + n
}

// 把一个总额平均分成 n 份（分位取整，最后一份兜差），避免出现 0.3333 这种脏数
function split(total, n) {
  const out = []
  const each = Math.round((total / n) * 100) / 100
  let rest = Math.round(total * 100)
  for (let i = 0; i < n; i++) {
    const last = i === n - 1
    const v = last ? rest / 100 : each
    out.push(v)
    rest -= Math.round((last ? rest / 100 : each) * 100)
  }
  return out
}

function buildSample() {
  const records = []
  let seq = 1
  let dayInMonth = 22

  SKUS.forEach(function (sku) {
    const total = sku.orders + sku.refunds
    if (!total) return

    const money = split(sku.sales || 0, sku.orders || 0)
    const refundMoney = sku.refunds && sku.sales ? split(sku.sales, sku.orders)[0] : 0

    for (let i = 0; i < total; i++) {
      const isRefund = i >= sku.orders
      const amount = isRefund ? refundMoney : (money[i] || 0)
      const day = sku.month === '09' ? 22 + (i % 8) : 1 + ((seq * 3) % 21)
      const hour = 10 + ((seq * 7) % 12)
      const minute = (seq * 13) % 60

      records.push({
        o: 'SO2026' + sku.month + pad(day) + pad(seq),
        st: '已完成',
        as: isRefund ? '退款成功' : '无',
        sp: sku.sp,
        sn: sku.sn,
        ss: sku.sn,
        q: isRefund ? 0 : 1,
        rec: isRefund ? -0 + amount : amount,
        sc: seq % 4 === 0 ? 8 : 0,
        mp: seq % 7 === 0 ? -6 : 0,
        fr: sku.fr,
        pv: ['广东', '浙江', '江苏', '上海', '四川'][seq % 5],
        ct: ['深圳', '杭州', '南京', '上海', '成都'][seq % 5],
        t: '2026-' + sku.month + '-' + pad(day) + ' ' + pad(hour) + ':' + pad(minute),
        iid: '1000' + (SKUS.indexOf(sku) + 1),
        nm: sku.nm,
        tl: ''
      })
      seq++
    }
    dayInMonth++
  })

  records.sort(function (a, b) { return a.t < b.t ? -1 : a.t > b.t ? 1 : 0 })

  // 期次与覆盖情况与真实导出的 summary 结构保持一致
  const t0 = records.length ? records[0].t.slice(0, 10) : ''
  const t1 = records.length ? records[records.length - 1].t.slice(0, 10) : ''

  return {
    orders: {
      records: records,
      truncated: false,
      sheet: '包裹详情',
      columns: 75,
      missing: [],
      summary: {
        rowCount: records.length,
        orderCount: records.length,
        dayFrom: t0,
        dayTo: t1
      }
    },
    params: {
      rows: PARAMS.map(function (p) { return { sp: p.sp, cost: p.cost } }),
      sheet: '拿货价',
      missing: [],
      missingCost: PARAMS.filter(function (p) { return p.cost === null }).map(function (p) { return p.sp }),
      summary: {
        specs: PARAMS.length,
        withCost: PARAMS.filter(function (p) { return p.cost !== null }).length,
        missingCostCount: PARAMS.filter(function (p) { return p.cost === null }).length
      }
    },
    // 平台扣费与推广费订单表里没有，示例里给一组贴近真实那期的数
    options: { ads: 670, platformFee: 926.2 }
  }
}

module.exports = { buildSample, SKUS, PARAMS }
