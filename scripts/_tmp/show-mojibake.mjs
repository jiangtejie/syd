import { readFileSync } from 'fs'
const t = readFileSync('src/renderer/src/pages/settings.css', 'utf8').split('\n')
const BAD = /[锛鐨鈥銆鍜鏄涓瑙瘑灞傛彁绀鏂浠婧鍥鐣鏍瀹鎴绾缂鍏閰閲鐜鍣鐢鎬鐞鎵缁鍒鍗鍐鎶鎻鐗鏉鐩鐪鎰瀵娴鐐鐔鐫]/
t.forEach((line, i) => { if (BAD.test(line)) console.log((i + 1) + ': ' + line) })
