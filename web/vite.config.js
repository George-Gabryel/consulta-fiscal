import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// host: true expoe o servidor de desenvolvimento na rede local, para testar
// de outra maquina antes de gerar o build.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    // Em desenvolvimento o front chama /api e o Vite repassa para o back-end.
    // Assim o navegador nunca precisa saber o endereco do servidor da API.
    proxy: {
      '/api': {
        target: process.env.API_ALVO ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist' },
});
