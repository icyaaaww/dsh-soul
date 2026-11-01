import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSkeletonEngine } from './src/compaction.js'

export const name = 'dsh-soul-compaction'
export const inject = ['llm', 'tokenMeter', 'sessions']

// Resolve after the host installs its profile module mapping, not at module evaluation.
// The default backend must be removed before mounting this replacement.
export async function apply(ctx, config = {}) {
  let Base
  try {
    const specifier = '@deepseek-ai/dsh-compaction-basic'
    const packages = typeof ctx.get === 'function' ? ctx.get('pluginPackages') : ctx.pluginPackages
    // Use the package selected by this host, including linked source checkouts outside
    // profiles/. Never search a global npm tree or load a bundled second host runtime.
    const selected = packages?.resolution?.entries?.findLast(entry => entry.name === specifier)
    const target = selected
      ? pathToFileURL(createRequire(join(selected.packageDir, 'package.json')).resolve(specifier)).href
      : specifier
    ;({ BasicCompactionEngine: Base } = await import(target))
  } catch (cause) {
    throw new Error('dsh-soul/compaction 无法解析宿主 @deepseek-ai/dsh-compaction-basic；' +
      '请通过 DSH profile 加载，或在自建宿主中提供与宿主同版本的压缩后端。', { cause })
  }
  if (typeof Base !== 'function' || typeof Base.prototype.compactNow !== 'function') {
    throw new Error('宿主压缩后端缺少 BasicCompactionEngine.compactNow，无法挂载图压缩')
  }
  const fiber = ctx.plugin(createSkeletonEngine(Base), config)
  await fiber.await()
  if (fiber.state !== 2) throw new Error('图压缩后端未启动，请检查宿主服务及是否仍挂载默认压缩后端')
  return () => fiber.dispose()
}
