import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      // 另一份构建产物：ui:preview 用 `--outDir out-preview` 生成（.gitignore 里也列了它）。
      // 漏了它会在**冷缓存**时把打包产物当源码 lint —— 实测 80170 条（6393 error）。
      // 之所以一直没暴露：eslint --cache 的缓存把这些文件记成了干净，缓存一失效
      //（换机器 / 删 .eslintcache）就会突然红一片。
      '**/out-preview',
      // 开发用探针/验证脚本(不参与应用构建,无 TS 上下文)
      'scripts/**'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      // 下划线前缀 = 有意不用的参数（签名要求占位，如 `keyFor ?? ((_filePath) => hexKey)`）。
      // 这是业内的既有约定，不加这条会把「故意不用」误报成「定义了没用到」。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ]
    }
  },
  eslintConfigPrettier
)
