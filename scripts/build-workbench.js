// 构建「利润核算工作台」单文件 HTML
//
// 用法：
//   node scripts/build-workbench.js                      # 产出到当前目录 ./利润核算工作台.html
//   node scripts/build-workbench.js --out <路径>          # 指定输出文件
//   node scripts/build-workbench.js --out <目录>          # 给目录则用默认文件名
//
// 为什么不重写一套网页版算法：口径必须只有一处实现。
// 早先吃过亏——利润在 agent 侧算好、页面只搬运，结果「换了数据数字也不变」。
// 这里把 assets/engine/ 的模块原样打包进 HTML，页面用极小 CommonJS 加载器跑它们；
// 同一批模块也能直接放进微信小程序的 utils/ 使用，两端永远同口径。
//
// 依赖：仅 Node 内置模块。产物是零外部依赖的单文件 HTML（无 CDN、无网络请求）。

const fs = require('fs')
const path = require('path')

const SKILL = path.resolve(__dirname, '..')
const ENGINE = path.join(SKILL, 'assets/engine')
const WEB = path.join(SKILL, 'assets/web')

// 键 = 浏览器里的模块名（扁平；源码里的 require('./x') 按 basename 解析）
const MODULES = {
  'zip-read': path.join(WEB, 'zip-read.js'),
  'xlsx-read': path.join(WEB, 'xlsx-read.js'),
  'sample': path.join(WEB, 'sample-data.js'),
  'ingest': path.join(ENGINE, 'ingest.js'),
  'csv': path.join(ENGINE, 'csv.js'),
  'xlsx': path.join(ENGINE, 'xlsx.js'),
  'compute': path.join(ENGINE, 'compute.js'),
  'advice': path.join(ENGINE, 'advice.js')
}

const TPL = path.join(WEB, 'workbench.tpl.html')
const DEFAULT_NAME = '利润核算工作台.html'

function readSource(p) {
  if (!fs.existsSync(p)) throw new Error('找不到模块源文件：' + p)
  return fs.readFileSync(p, 'utf8')
}

function bundle() {
  const map = {}
  const sizes = []
  Object.keys(MODULES).forEach(function (name) {
    const src = readSource(MODULES[name])
    map[name] = src
    sizes.push({ name: name, bytes: Buffer.byteLength(src, 'utf8') })
  })
  // 源码里若出现 </script 会提前闭合标签，转义成 <\/script（JSON 里等价）
  const json = JSON.stringify(map).replace(/<\//g, '<\\/')
  return { json: json, sizes: sizes }
}

function resolveOut(out) {
  if (!out) return path.resolve(process.cwd(), DEFAULT_NAME)
  const abs = path.resolve(out)
  // 已存在且是目录，或路径以分隔符结尾 → 当目录处理
  if (/[\\/]$/.test(out) || (fs.existsSync(abs) && fs.statSync(abs).isDirectory())) {
    return path.join(abs, DEFAULT_NAME)
  }
  return abs
}

function build(opts) {
  opts = opts || {}
  const outPath = resolveOut(opts.out)
  const tpl = readSource(TPL)
  const b = bundle()

  if (tpl.indexOf('/*__WB_MODULES__*/') < 0) {
    throw new Error('模板里找不到注入占位符 /*__WB_MODULES__*/')
  }
  const html = tpl.replace('/*__WB_MODULES__*/', b.json)

  // 产物里不允许再有占位符
  const left = html.match(/\/\*__WB_[A-Z_]+__\*\//g)
  if (left) throw new Error('还有未替换的占位符：' + left.join(', '))

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, html, 'utf8')

  if (!opts.quiet) {
    console.log('已生成 ' + outPath)
    console.log('  模板 ' + Buffer.byteLength(tpl, 'utf8') + ' bytes')
    b.sizes.forEach(function (s) {
      console.log('  + ' + s.name.padEnd(10) + String(s.bytes).padStart(7) + ' bytes')
    })
    console.log('  合计 ' + Buffer.byteLength(html, 'utf8') + ' bytes')
  }
  return outPath
}

if (require.main === module) {
  const argv = process.argv.slice(2)
  let out = ''
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' || argv[i] === '-o') out = argv[++i] || ''
  }
  build({ out: out })
}

module.exports = { build, MODULES, DEFAULT_NAME }
