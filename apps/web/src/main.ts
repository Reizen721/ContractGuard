import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { setupDomI18n } from './i18n'

setupDomI18n()
createApp(App).mount('#app')

