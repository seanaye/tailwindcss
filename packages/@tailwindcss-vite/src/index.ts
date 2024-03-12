import { IO, Parsing, scanFiles } from '@tailwindcss/oxide'
import path from 'path'
import { compile, optimizeCss } from 'tailwindcss'
import type { Plugin, Rollup, Update, ViteDevServer } from 'vite'

export default function tailwindcss(): Plugin[] {
  let server: ViteDevServer | null = null
  let candidates = new Set<string>()
  let cssModules = new Set<string>()
  let minify = false
  let plugins: readonly Plugin[] = []

  function isCssFile(id: string) {
    let [filename] = id.split('?', 2)
    let extension = path.extname(filename).slice(1)
    return extension === 'css'
  }

  // Trigger update to all css modules
  function updateCssModules() {
    // If we're building then we don't need to update anything
    if (!server) return

    let updates: Update[] = []
    for (let id of cssModules.values()) {
      let cssModule = server.moduleGraph.getModuleById(id)
      if (!cssModule) {
        // It is safe to remove the item here since we're iterating on a copy of
        // the values.
        cssModules.delete(id)
        continue
      }

      server.moduleGraph.invalidateModule(cssModule)
      updates.push({
        type: `${cssModule.type}-update`,
        path: cssModule.url,
        acceptedPath: cssModule.url,
        timestamp: Date.now(),
      })
    }

    if (updates.length > 0) {
      server.hot.send({ type: 'update', updates })
    }
  }

  function scan(src: string, extension: string) {
    let updated = false
    // Parse all candidates given the resolved files
    for (let candidate of scanFiles(
      [{ content: src, extension }],
      IO.Sequential | Parsing.Sequential,
    )) {
      // On an initial or full build, updated becomes true immediately so we
      // won't be making extra checks.
      if (!updated) {
        if (candidates.has(candidate)) continue
        updated = true
      }
      candidates.add(candidate)
    }
    return updated
  }

  function generateCss(css: string) {
    return compile(css).build(Array.from(candidates))
  }

  function generateOptimizedCss(css: string) {
    return optimizeCss(generateCss(css), { minify })
  }

  // Transform the CSS by manually run the transform functions of non-Tailwind plugins on the given
  // CSS.
  async function transformWithPlugins(context: Rollup.PluginContext, css: string) {
    let transformPluginContext = {
      ...context,
      getCombinedSourcemap: () => {
        throw new Error('getCombinedSourcemap not implemented')
      },
    }
    let fakeCssId = `__tailwind_utilities.css`

    for (let plugin of plugins) {
      if (
        // Skip our own plugins
        plugin.name.startsWith('@tailwindcss/') ||
        // Skip vite:css-post because it transforms CSS into JS for the dev
        // server too late in the pipeline.
        plugin.name === 'vite:css-post' ||
        // Skip vite:import-analysis and vite:build-import-analysis because they try
        // to process CSS as JS and fail.
        plugin.name.includes('import-analysis')
      )
        continue

      if (!plugin.transform) continue
      const transformHandler =
        'handler' in plugin.transform! ? plugin.transform.handler : plugin.transform!

      try {
        // Based on https://github.com/unocss/unocss/blob/main/packages/vite/src/modes/global/build.ts#L43
        let result = await transformHandler.call(transformPluginContext, css, fakeCssId)
        if (!result) continue
        if (typeof result === 'string') {
          css = result
        } else if (result.code) {
          css = result.code
        }
      } catch (e) {
        console.error(`Error running ${plugin.name} on Tailwind CSS output. Skipping.`)
      }
    }
    return css
  }

  return [
    {
      // Step 1: Scan source files for candidates
      name: '@tailwindcss/vite:scan',
      enforce: 'pre',

      configureServer(_server) {
        server = _server
      },

      async configResolved(config) {
        minify = config.build.cssMinify !== false
        plugins = config.plugins
      },

      // Scan index.html for candidates
      transformIndexHtml(html) {
        let updated = scan(html, 'html')

        // In dev mode, if the generated CSS contains a URL that causes the
        // browser to load a page (e.g. an URL to a missing image), triggering a
        // CSS update will cause an infinite loop. We only trigger if the
        // candidates have been updated.
        if (server && updated) {
          updateCssModules()
        }
      },

      // Scan all other files for candidates
      transform(src, id) {
        if (id.includes('/.vite/')) return
        let [filename] = id.split('?', 2)
        let extension = path.extname(filename).slice(1)
        if (extension === '' || extension === 'css') return

        scan(src, extension)

        if (server) {
          updateCssModules()
        }
      },
    },

    {
      // Step 2 (dev mode): Generate CSS
      name: '@tailwindcss/vite:generate:serve',
      apply: 'serve',
      async transform(src, id) {
        if (!isCssFile(id) || !src.includes('@tailwind')) return

        cssModules.add(id)

        let css = generateCss(src)
        css = await transformWithPlugins(this, css)
        return { code: css }
      },
    },

    {
      // Step 2 (full build): Generate CSS
      name: '@tailwindcss/vite:generate:build',
      enforce: 'post',
      apply: 'build',
      async generateBundle(_options, bundle) {
        for (let id in bundle) {
          let item = bundle[id]
          if (item.type !== 'asset') continue
          if (!isCssFile(id)) continue
          let rawSource = item.source
          let source =
            rawSource instanceof Uint8Array ? new TextDecoder().decode(rawSource) : rawSource
          if (!source.includes('@tailwind')) continue

          let css = generateOptimizedCss(source)
          css = await transformWithPlugins(this, css)
          item.source = css
        }
      },
    },
  ] satisfies Plugin[]
}
