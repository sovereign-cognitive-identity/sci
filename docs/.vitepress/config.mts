import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Sci',
  description: 'Sovereign Cognitive Identity — a proxy between you and every AI system you use.',
  base: '/sci/',

  head: [
    ['meta', { name: 'og:title', content: 'Sci — Sovereign Cognitive Identity' }],
    ['meta', { name: 'og:description', content: 'A proxy that sits between you and every AI system you use. Protects your privacy, preserves your context, optimizes your costs.' }],
  ],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/quick-start' },
      { text: 'Reference', link: '/reference/cli' },
      { text: 'Architecture', link: '/architecture/overview' },
      { text: 'GitHub', link: 'https://github.com/sovereign-cognitive-identity/sci' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'What is Sci?', link: '/guide/what-is-sci' },
            { text: 'Quick Start', link: '/guide/quick-start' },
            { text: 'The Privacy Guarantee', link: '/guide/privacy' },
            { text: 'Connecting Agents', link: '/guide/connecting-agents' },
            { text: 'Storage Backends', link: '/guide/storage' },
            { text: 'Nightly Consolidation', link: '/guide/consolidation' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'CLI Commands', link: '/reference/cli' },
            { text: 'MCP Tools', link: '/reference/mcp-tools' },
            { text: 'Environment Variables', link: '/reference/env-vars' },
            { text: 'Auth Tiers', link: '/reference/auth-tiers' },
          ],
        },
      ],
      '/architecture/': [
        {
          text: 'Architecture',
          items: [
            { text: 'Overview', link: '/architecture/overview' },
            { text: 'Memory Layers', link: '/architecture/memory' },
            { text: 'Anonymization Pipeline', link: '/architecture/anonymization' },
            { text: 'Hybrid Retrieval', link: '/architecture/retrieval' },
            { text: 'Storage Adapters', link: '/architecture/storage' },
            { text: 'Stack Decisions', link: '/architecture/decisions' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/sovereign-cognitive-identity/sci' },
    ],

    footer: {
      message: 'Released under <a href="https://github.com/sovereign-cognitive-identity/sci/blob/main/LICENSE">AGPL-3.0</a>. <a href="https://github.com/sovereign-cognitive-identity/sci/blob/main/COMMERCIAL_LICENSE.md">Commercial license</a> available for service operators.',
      copyright: 'Copyright © 2026 Casey Zandbergen',
    },

    search: {
      provider: 'local',
    },

    editLink: {
      pattern: 'https://github.com/sovereign-cognitive-identity/sci/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
})
