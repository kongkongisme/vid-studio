import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [
      vue({
        template: {
          compilerOptions: {
            // 告知 Vue 编译器 <webview> 是原生自定义元素，无需解析为组件
            isCustomElement: (tag) => tag === 'webview'
          }
        }
      }),
      tailwindcss()
    ]
  }
})
