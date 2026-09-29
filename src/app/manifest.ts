import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Seu Doutor', short_name: 'Seu Doutor', description: 'Busque e agende consultas médicas.',
    start_url: '/app', scope: '/', display: 'standalone', background_color: '#f6f8fc', theme_color: '#1263c9', lang: 'pt-BR',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
