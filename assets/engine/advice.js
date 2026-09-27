// 格式化 + 建议价规则引擎
//
// 规则只依赖「订单导出 + 拿货价」能算出来的东西：单均利润、履约后利润、
// 退款率、成交量。推广费是全局一个数，摊不到单个 SKU 头上，所以这一版
// 不用 ROI 做单款判断 —— 宁可少一条规则，也不拿摊出来的假 ROI 下结论。

const LAYER_COLORS = {
  爆款: '#2563eb',
  潜力款: '#f59e0b',
  常规款: '#94a3b8',
  滞销款: '#cbd5e1'
}

const ROLE_CLASS = {
  利润款: 'r-profit',
  基础款: 'r-base',
  过度款: 'r-over',
  滞销款: 'r-dead',
  待核数据: 'r-warn',
  先治退款: 'r-warn',
  常规款: 'r-base'
}

function money(n) {
  if (n === null || n === undefined) return '—'
  const v = Number(n)
  if (!isFinite(v)) return '—'
  const neg = v < 0
  const parts = Math.abs(v).toFixed(0)
  const head = parts.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (neg ? '-¥' : '¥') + head
}

function money2(n) {
  if (n === null || n === undefined) return '—'
  const v = Number(n)
  if (!isFinite(v)) return '—'
  const neg = v < 0
  const parts = Math.abs(v).toFixed(2).split('.')
  const head = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (neg ? '-¥' : '¥') + head + '.' + parts[1]
}

function num(n) {
  if (n === null || n === undefined) return '—'
  const v = Number(n)
  if (!isFinite(v)) return '—'
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function pct(n) {
  if (n === null || n === undefined) return '—'
  const v = Number(n)
  if (!isFinite(v)) return '—'
  return (v * 100).toFixed(1) + '%'
}

function price(v) {
  if (v === null || v === undefined) return '—'
  const n = Number(v)
  if (!isFinite(n) || n <= 0) return '—'
  return '¥' + (n >= 100 ? n.toFixed(0) : n.toFixed(1))
}

// 判定每个 SKU 的定位、调整动作与建议价
function buildAdvice(skus) {
  const list = skus || []
  const withOrd = list.filter(s => s.orders > 0 && s.unit !== null && s.unit !== undefined)
  const unitDesc = withOrd.slice().sort((a, b) => b.unit - a.unit)
  const topCount = Math.max(1, Math.ceil(unitDesc.length * 0.3))
  const top30 = {}
  unitDesc.slice(0, topCount).forEach(s => {
    top30[s.name || s.spec] = true
  })
  const maxOrd = withOrd.reduce((m, s) => Math.max(m, s.orders), 0)

  return list.map(s => {
    const avg = s.avg_price !== null && s.avg_price !== undefined
      ? s.avg_price
      : s.orders > 0 ? s.sales / s.orders : null
    const key = s.name || s.spec
    let role = '常规款'
    let act = '本期不动价，记下这个数，下一期对比再看趋势'
    let sug = avg ? price(avg) + '（维持现价）' : '—'
    let priority = 3

    if (s.missing_cost) {
      role = '待核数据'
      act = '参数表里没有这款的拿货价，成本按 0 算，利润是虚的；先补上拿货价再谈调价'
      sug = avg ? price(avg) + '（先别动）' : '—'
      priority = 1
    } else if (s.orders === 0) {
      role = '滞销款'
      act = '本期 0 单，先换主图标题再给一轮曝光；下一期仍 0 单就按清仓处理'
      sug = '清仓参考价 = 拿货价 + 运费 + 3 元'
      priority = 1
    } else if (s.refund_rate > 0.15) {
      role = '先治退款'
      act = '退款率 ' + pct(s.refund_rate) + '（' + s.refund_orders + '/' + (s.orders + s.refund_orders) +
        ' 单），本期不动价：先查主因是尺码、质量还是描述不符，修好再进调价流程'
      sug = price(avg) + '（先别动）'
      priority = 1
    } else if (s.post !== null && s.post < 0) {
      role = '过度款'
      act = '履约后利润为 ' + money2(s.post) + '，每卖一单在亏钱：先砍投放，再单变量降价，连亏两期就下掉'
      sug = '建议到手价 ' + price(avg * 0.88) + '~' + price(avg * 0.92) + '（降 8–12%）'
      priority = 2
    } else if (top30[key] && s.unit > 0 && s.refund_rate <= 0.1) {
      role = '利润款'
      act = '单均利润 ' + money2(s.unit) + '，是本期最能赚的一款：涨价试探 +5–8%，观察 14 天转化，掉超 20% 立刻回撤'
      sug = '建议到手价 ' + price(avg * 1.05) + '~' + price(avg * 1.08)
      priority = 2
    } else if (s.orders >= maxOrd * 0.6 && maxOrd > 1) {
      role = '基础款'
      act = '走量的款，任务是撑店铺权重：锁价不动，守住成本线上方就行'
      sug = price(avg) + '（维持现价）'
      priority = 3
    }

    return Object.assign({}, s, {
      role: role,
      roleClass: ROLE_CLASS[role] || 'r-base',
      act: act,
      sug: sug,
      priority: priority,
      salesText: money2(s.sales),
      ordersText: num(s.orders) + ' 单',
      qtyText: num(s.qty) + ' 件',
      unitText: s.unit === null || s.unit === undefined ? '—' : money2(s.unit),
      unitNeg: s.unit !== null && s.unit !== undefined && s.unit < 0,
      avgText: avg === null || avg === undefined ? '—' : money2(avg),
      marginText: s.gross_margin === null || s.gross_margin === undefined ? '—' : pct(s.gross_margin),
      costText: money2(s.cost),
      grossText: money2(s.gross_profit),
      postText: money2(s.post),
      refundText: pct(s.refund_rate),
      refundWarn: s.refund_rate > 0.15,
      layerColor: LAYER_COLORS[s.layer] || '#94a3b8'
    })
  })
}

module.exports = { buildAdvice, money, money2, num, pct, price, LAYER_COLORS }
